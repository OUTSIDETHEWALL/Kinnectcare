from fastapi import FastAPI, APIRouter, HTTPException, Depends, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import json
import logging
import uuid
from pathlib import Path
from pydantic import BaseModel, Field, EmailStr
from typing import List, Optional
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
import jwt
import stripe
from passlib.context import CryptContext
from pydantic import field_validator

from expo_push import send_expo_push
import billing


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env', override=False)

mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

SECRET_KEY = os.environ.get("JWT_SECRET", "kinnship-dev-secret-change-in-prod")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
security = HTTPBearer()

app = FastAPI(title="Kinnship API")
api_router = APIRouter(prefix="/api")


# ========== Models ==========
class UserSignup(BaseModel):
    email: EmailStr
    password: str
    full_name: str
    timezone: Optional[str] = None


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class UserResponse(BaseModel):
    id: str
    email: str
    full_name: str
    timezone: Optional[str] = "UTC"


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserResponse


class TimezoneUpdate(BaseModel):
    timezone: str


class PushTokenRegister(BaseModel):
    token: str
    platform: Optional[str] = None


class FamilyMemberCreate(BaseModel):
    name: str
    age: int
    phone: str
    gender: str
    role: str = "family"


class FamilyMember(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    owner_id: str
    name: str
    age: int
    phone: str
    gender: str
    role: str
    status: str = "healthy"
    last_seen: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    location_name: Optional[str] = "Home"
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    avatar_url: Optional[str] = None
    daily_checkin_time: Optional[str] = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class CheckinSettings(BaseModel):
    daily_checkin_time: Optional[str] = None


class TimeSlot(BaseModel):
    time: str  # "HH:MM"
    label: Optional[str] = None  # e.g. "Morning", "Afternoon", or user-defined


class Reminder(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    owner_id: str
    member_id: str
    member_name: str
    category: str = "medication"
    title: str
    dosage: Optional[str] = None
    times: List[TimeSlot] = Field(default_factory=list)
    time: str = ""
    status: str = "pending"
    taken: bool = False
    last_marked_at: Optional[datetime] = None
    last_marked_date: Optional[str] = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    @field_validator("times", mode="before")
    @classmethod
    def _coerce_times(cls, v):
        return _coerce_time_list(v)

    @classmethod
    def _coerce_times_static(cls, v):
        return _coerce_time_list(v)


class ReminderCreate(BaseModel):
    member_id: str
    title: str
    category: str = "medication"
    dosage: Optional[str] = None
    times: List[TimeSlot] = Field(default_factory=list)

    @field_validator("times", mode="before")
    @classmethod
    def _coerce_times(cls, v):
        return _coerce_time_list(v)


class ReminderUpdate(BaseModel):
    title: Optional[str] = None
    dosage: Optional[str] = None
    times: Optional[List[TimeSlot]] = None

    @field_validator("times", mode="before")
    @classmethod
    def _coerce_times(cls, v):
        if v is None:
            return None
        return _coerce_time_list(v)


class ReminderMark(BaseModel):
    status: str


class Alert(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    owner_id: str
    member_id: str
    member_name: str
    type: str
    severity: str
    title: str
    message: str
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    acknowledged: bool = False
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class CheckIn(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    owner_id: str
    member_id: str
    member_name: str
    location_name: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class CheckInCreate(BaseModel):
    member_id: str
    location_name: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None


class LocationUpdate(BaseModel):
    latitude: float
    longitude: float
    location_name: Optional[str] = None


class SOSRequest(BaseModel):
    member_id: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    fall_detected: Optional[bool] = False


# ========== Auth helpers ==========
def hash_password(p: str) -> str:
    return pwd_context.hash(p)


def verify_password(p: str, h: str) -> bool:
    return pwd_context.verify(p, h)


def create_access_token(user_id: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    return jwt.encode({"sub": user_id, "exp": expire}, SECRET_KEY, algorithm=ALGORITHM)


async def get_current_user(creds: HTTPAuthorizationCredentials = Depends(security)) -> dict:
    try:
        payload = jwt.decode(creds.credentials, SECRET_KEY, algorithms=[ALGORITHM])
        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(status_code=401, detail="Invalid token")
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    user = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


# ========== Time / TZ helpers ==========
def user_tz(user: dict) -> ZoneInfo:
    tz = user.get("timezone") or "UTC"
    try:
        return ZoneInfo(tz)
    except ZoneInfoNotFoundError:
        return ZoneInfo("UTC")


def local_today_str(user: dict) -> str:
    return datetime.now(user_tz(user)).date().isoformat()


def parse_hhmm(s: str) -> Optional[int]:
    try:
        h, m = s.split(":")
        h_i, m_i = int(h), int(m)
        if not (0 <= h_i <= 23 and 0 <= m_i <= 59):
            return None
        if len(h) != 2 or len(m) != 2:
            return None
        return h_i * 60 + m_i
    except Exception:
        return None


def _coerce_time_list(v):
    if not v:
        return []
    out = []
    for t in v:
        if isinstance(t, str):
            out.append({"time": t, "label": None})
        elif isinstance(t, dict):
            out.append({"time": t.get("time", ""), "label": t.get("label")})
        elif hasattr(t, "model_dump"):
            out.append(t.model_dump())
        else:
            out.append(t)
    return out


async def push_to_user(user_id: str, title: str, body: str, data: dict) -> int:
    """Send push to all registered push tokens for a user. Best-effort.
    Returns the number of devices the push was attempted on (0 if user has none).
    """
    user = await db.users.find_one({"id": user_id}, {"_id": 0, "push_tokens": 1})
    if not user:
        return 0
    tokens = user.get("push_tokens") or []
    if not tokens:
        return 0
    try:
        await send_expo_push(tokens, title, body, data)
    except Exception as e:
        logger.warning(f"push_to_user failed for {user_id}: {e}")
    return len(tokens)


# ========== Daily reset ==========
async def reset_daily_reminder_statuses(owner_id: str):
    user = await db.users.find_one({"id": owner_id}, {"_id": 0})
    if not user:
        return
    today = local_today_str(user)
    docs = await db.reminders.find({"owner_id": owner_id, "status": {"$ne": "pending"}}, {"_id": 0}).to_list(2000)
    for d in docs:
        if d.get("last_marked_date") and d["last_marked_date"] != today:
            await db.reminders.update_one(
                {"id": d["id"]}, {"$set": {"status": "pending", "taken": False}}
            )


async def detect_missed_checkins(owner_id: str):
    user = await db.users.find_one({"id": owner_id}, {"_id": 0})
    if not user:
        return
    tz = user_tz(user)
    now_local = datetime.now(tz)
    today = now_local.date().isoformat()
    now_minutes = now_local.hour * 60 + now_local.minute
    # Today start in UTC for the user's local day
    day_start_local = datetime(now_local.year, now_local.month, now_local.day, tzinfo=tz)
    day_start_utc = day_start_local.astimezone(timezone.utc)

    members = await db.members.find(
        {"owner_id": owner_id, "daily_checkin_time": {"$ne": None}}, {"_id": 0}
    ).to_list(500)
    for m in members:
        t = m.get("daily_checkin_time")
        if not t:
            continue
        expected = parse_hhmm(t)
        if expected is None or now_minutes < expected:
            continue
        has_ci = await db.checkins.find_one(
            {"owner_id": owner_id, "member_id": m["id"], "created_at": {"$gte": day_start_utc}}
        )
        if has_ci:
            continue
        existing = await db.alerts.find_one({
            "owner_id": owner_id, "member_id": m["id"], "type": "missed_checkin",
            "created_at": {"$gte": day_start_utc},
        })
        if existing:
            continue
        a = Alert(
            owner_id=owner_id, member_id=m["id"], member_name=m["name"],
            type="missed_checkin", severity="critical",
            title=f"{m['name']} missed daily check-in",
            message=f"Expected by {t} ({user.get('timezone') or 'UTC'}) today. They haven't checked in yet.",
        )
        await db.alerts.insert_one(a.model_dump())
        await db.members.update_one({"id": m["id"]}, {"$set": {"status": "warning"}})
        # Push notify
        await push_to_user(
            owner_id,
            f"⚠️ {m['name']} missed check-in",
            f"Expected by {t}. Tap to call or check on them.",
            {"type": "missed_checkin", "member_id": m["id"]},
        )


# ========== Seed ==========
async def seed_demo_data(owner_id: str):
    gregory = FamilyMember(
        owner_id=owner_id, name="Gregory", age=35, phone="+1-555-0142", gender="Male",
        role="family", status="healthy", location_name="Downtown Office",
        avatar_url="https://images.unsplash.com/photo-1592234789031-94bf65f630ed?crop=entropy&cs=srgb&fm=jpg&w=400",
    )
    james = FamilyMember(
        owner_id=owner_id, name="James", age=78, phone="+1-555-0178", gender="Male",
        role="senior", status="warning", location_name="Home",
        daily_checkin_time="09:00",
        avatar_url="https://images.unsplash.com/photo-1667312147803-4b2437b5485e?crop=entropy&cs=srgb&fm=jpg&w=400",
    )
    await db.members.insert_many([gregory.model_dump(), james.model_dump()])

    meds = [
        Reminder(owner_id=owner_id, member_id=james.id, member_name=james.name,
                 category="medication", title="Metformin", dosage="500mg, 1 pill",
                 times=[TimeSlot(time="08:00", label="Morning"), TimeSlot(time="20:00", label="Bedtime")], time="08:00"),
        Reminder(owner_id=owner_id, member_id=james.id, member_name=james.name,
                 category="medication", title="Lisinopril", dosage="10mg",
                 times=[TimeSlot(time="13:00", label="Afternoon")], time="13:00"),
        Reminder(owner_id=owner_id, member_id=james.id, member_name=james.name,
                 category="medication", title="Aspirin", dosage="81mg",
                 times=[TimeSlot(time="09:00", label="Morning")], time="09:00"),
    ]
    routines = [
        Reminder(owner_id=owner_id, member_id=james.id, member_name=james.name,
                 category="routine", title="Drink water",
                 times=[TimeSlot(time="10:00"), TimeSlot(time="14:00"), TimeSlot(time="18:00")], time="10:00"),
        Reminder(owner_id=owner_id, member_id=james.id, member_name=james.name,
                 category="routine", title="Morning walk",
                 times=[TimeSlot(time="07:30", label="Morning")], time="07:30"),
        Reminder(owner_id=owner_id, member_id=james.id, member_name=james.name,
                 category="routine", title="Breakfast",
                 times=[TimeSlot(time="08:30", label="Morning")], time="08:30"),
        Reminder(owner_id=owner_id, member_id=james.id, member_name=james.name,
                 category="routine", title="Dinner",
                 times=[TimeSlot(time="19:00", label="Evening")], time="19:00"),
    ]
    await db.reminders.insert_many([r.model_dump() for r in meds + routines])

    alerts = [
        Alert(owner_id=owner_id, member_id=james.id, member_name=james.name,
              type="low_battery", severity="warning",
              title="Low battery on James's device",
              message="Battery level is 15%. Please remind him to charge."),
        Alert(owner_id=owner_id, member_id=james.id, member_name=james.name,
              type="medication", severity="warning",
              title="Medication missed",
              message="James missed his 8:00 AM Metformin."),
    ]
    await db.alerts.insert_many([a.model_dump() for a in alerts])


# ========== Auth Routes ==========
def _user_response(u: dict) -> UserResponse:
    return UserResponse(
        id=u["id"], email=u["email"], full_name=u["full_name"],
        timezone=u.get("timezone") or "UTC",
    )


@api_router.post("/auth/signup", response_model=TokenResponse)
async def signup(data: UserSignup):
    if await db.users.find_one({"email": data.email.lower()}):
        raise HTTPException(status_code=409, detail="Email already registered")
    tz = data.timezone or "UTC"
    try:
        ZoneInfo(tz)
    except ZoneInfoNotFoundError:
        tz = "UTC"
    user_id = str(uuid.uuid4())
    doc = {
        "id": user_id, "email": data.email.lower(), "full_name": data.full_name,
        "hashed_password": hash_password(data.password),
        "timezone": tz, "push_tokens": [],
        "created_at": datetime.now(timezone.utc),
    }
    await db.users.insert_one(doc)
    await seed_demo_data(user_id)
    return TokenResponse(
        access_token=create_access_token(user_id),
        user=_user_response(doc),
    )


@api_router.post("/auth/login", response_model=TokenResponse)
async def login(data: UserLogin):
    user = await db.users.find_one({"email": data.email.lower()})
    if not user or not verify_password(data.password, user["hashed_password"]):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    return TokenResponse(
        access_token=create_access_token(user["id"]),
        user=_user_response(user),
    )


@api_router.get("/auth/me", response_model=UserResponse)
async def me(current=Depends(get_current_user)):
    return _user_response(current)


@api_router.put("/auth/timezone", response_model=UserResponse)
async def set_timezone(data: TimezoneUpdate, current=Depends(get_current_user)):
    try:
        ZoneInfo(data.timezone)
    except ZoneInfoNotFoundError:
        raise HTTPException(status_code=400, detail="Invalid IANA timezone")
    await db.users.update_one({"id": current["id"]}, {"$set": {"timezone": data.timezone}})
    current["timezone"] = data.timezone
    return _user_response(current)


@api_router.post("/auth/push-token")
async def register_push_token(data: PushTokenRegister, current=Depends(get_current_user)):
    if not data.token or not data.token.startswith("ExponentPushToken["):
        return {"ok": False, "reason": "invalid token format"}
    await db.users.update_one(
        {"id": current["id"]}, {"$addToSet": {"push_tokens": data.token}}
    )
    return {"ok": True}


class DeleteAccountRequest(BaseModel):
    confirm: Optional[str] = None  # Expect "DELETE" for extra safety


@api_router.delete("/auth/account")
async def delete_account(
    data: DeleteAccountRequest = None,
    current=Depends(get_current_user),
):
    """Permanently delete the authenticated user and ALL of their data.

    Steps:
      1. Cancel active Stripe subscription (best-effort).
      2. Delete all user-owned collections.
      3. Delete the user document.
    """
    user_id = current["id"]
    payload = data or DeleteAccountRequest()
    if (payload.confirm or "").strip().upper() != "DELETE":
        raise HTTPException(
            status_code=400,
            detail='Confirmation required. Send {"confirm":"DELETE"} to proceed.',
        )

    sub = (current.get("subscription") or {})
    sub_id = sub.get("stripe_subscription_id")
    customer_id = sub.get("stripe_customer_id")
    stripe_canceled = False
    customer_deleted = False
    if billing.is_configured():
        # Best-effort cancellation. Do not block account deletion if Stripe fails.
        try:
            if sub_id:
                stripe.Subscription.delete(sub_id)
                stripe_canceled = True
        except Exception as e:
            logger.warning(f"Stripe subscription cancel failed for {user_id}: {e}")
        try:
            if customer_id:
                stripe.Customer.delete(customer_id)
                customer_deleted = True
        except Exception as e:
            logger.warning(f"Stripe customer delete failed for {user_id}: {e}")

    # Delete all user-owned data.
    deleted_counts = {}
    for coll in [
        "members",
        "reminders",
        "checkins",
        "alerts",
        "medication_logs",
    ]:
        try:
            r = await db[coll].delete_many({"owner_id": user_id})
            deleted_counts[coll] = r.deleted_count
        except Exception as e:
            logger.warning(f"Failed to delete from {coll} for {user_id}: {e}")
            deleted_counts[coll] = 0

    # Finally delete the user.
    await db.users.delete_one({"id": user_id})

    logger.info(
        f"Account deleted: user={user_id} stripe_sub_canceled={stripe_canceled} "
        f"stripe_customer_deleted={customer_deleted} counts={deleted_counts}"
    )
    return {
        "ok": True,
        "deleted": deleted_counts,
        "stripe_subscription_canceled": stripe_canceled,
        "stripe_customer_deleted": customer_deleted,
    }


# ========== Members ==========
@api_router.get("/members", response_model=List[FamilyMember])
async def list_members(current=Depends(get_current_user)):
    docs = await db.members.find({"owner_id": current["id"]}, {"_id": 0}).to_list(1000)
    return [FamilyMember(**d) for d in docs]


@api_router.post("/members", response_model=FamilyMember)
async def create_member(data: FamilyMemberCreate, current=Depends(get_current_user)):
    # Enforce free tier member limit.
    limit = billing.get_member_limit(current)
    if limit != float("inf"):
        existing = await db.members.count_documents({"owner_id": current["id"]})
        if existing >= int(limit):
            raise HTTPException(
                status_code=402,
                detail={
                    "paywall": True,
                    "code": "member_limit_reached",
                    "message": (
                        f"Free plan allows up to {int(limit)} family members. "
                        "Upgrade to the Family Plan for unlimited members."
                    ),
                    "current": existing,
                    "limit": int(limit),
                },
            )
    role = data.role if data.role in ("family", "senior") else ("senior" if data.age >= 60 else "family")
    member = FamilyMember(
        owner_id=current["id"], name=data.name, age=data.age, phone=data.phone,
        gender=data.gender, role=role, status="healthy", location_name="Unknown",
        daily_checkin_time="09:00" if role == "senior" else None,
    )
    await db.members.insert_one(member.model_dump())
    return member


@api_router.get("/members/{member_id}", response_model=FamilyMember)
async def get_member(member_id: str, current=Depends(get_current_user)):
    doc = await db.members.find_one({"id": member_id, "owner_id": current["id"]}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Member not found")
    return FamilyMember(**doc)


@api_router.delete("/members/{member_id}")
async def delete_member(member_id: str, current=Depends(get_current_user)):
    r = await db.members.delete_one({"id": member_id, "owner_id": current["id"]})
    if r.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Member not found")
    await db.reminders.delete_many({"owner_id": current["id"], "member_id": member_id})
    await db.checkins.delete_many({"owner_id": current["id"], "member_id": member_id})
    await db.medication_logs.delete_many({"owner_id": current["id"], "member_id": member_id})
    return {"ok": True}


@api_router.put("/members/{member_id}/location", response_model=FamilyMember)
async def update_member_location(member_id: str, data: LocationUpdate, current=Depends(get_current_user)):
    update = {"latitude": data.latitude, "longitude": data.longitude, "last_seen": datetime.now(timezone.utc)}
    if data.location_name:
        update["location_name"] = data.location_name
    r = await db.members.update_one({"id": member_id, "owner_id": current["id"]}, {"$set": update})
    if r.matched_count == 0:
        raise HTTPException(status_code=404, detail="Member not found")
    doc = await db.members.find_one({"id": member_id}, {"_id": 0})
    return FamilyMember(**doc)


@api_router.put("/members/{member_id}/checkin-settings", response_model=FamilyMember)
async def update_checkin_settings(member_id: str, data: CheckinSettings, current=Depends(get_current_user)):
    val = data.daily_checkin_time
    if val and parse_hhmm(val) is None:
        raise HTTPException(status_code=400, detail="daily_checkin_time must be HH:MM format")
    r = await db.members.update_one(
        {"id": member_id, "owner_id": current["id"]},
        {"$set": {"daily_checkin_time": val}}
    )
    if r.matched_count == 0:
        raise HTTPException(status_code=404, detail="Member not found")
    doc = await db.members.find_one({"id": member_id}, {"_id": 0})
    return FamilyMember(**doc)


# ========== Alerts ==========
@api_router.get("/alerts", response_model=List[Alert])
async def list_alerts(current=Depends(get_current_user)):
    await detect_missed_checkins(current["id"])
    docs = await db.alerts.find({"owner_id": current["id"]}, {"_id": 0}).sort("created_at", -1).to_list(2000)
    return [Alert(**d) for d in docs]


@api_router.post("/alerts/{alert_id}/ack")
async def acknowledge_alert(alert_id: str, current=Depends(get_current_user)):
    r = await db.alerts.update_one(
        {"id": alert_id, "owner_id": current["id"]}, {"$set": {"acknowledged": True}}
    )
    if r.matched_count == 0:
        raise HTTPException(status_code=404, detail="Alert not found")
    return {"ok": True}


# ========== Reminders ==========
@api_router.get("/reminders", response_model=List[Reminder])
async def list_reminders(current=Depends(get_current_user)):
    await reset_daily_reminder_statuses(current["id"])
    docs = await db.reminders.find({"owner_id": current["id"]}, {"_id": 0}).to_list(2000)
    return [Reminder.model_validate(d) for d in docs]


@api_router.get("/reminders/member/{member_id}", response_model=List[Reminder])
async def list_member_reminders(member_id: str, current=Depends(get_current_user)):
    await reset_daily_reminder_statuses(current["id"])
    docs = await db.reminders.find(
        {"owner_id": current["id"], "member_id": member_id}, {"_id": 0}
    ).to_list(2000)
    return [Reminder.model_validate(d) for d in docs]


@api_router.post("/reminders", response_model=Reminder)
async def create_reminder(data: ReminderCreate, current=Depends(get_current_user)):
    member = await db.members.find_one({"id": data.member_id, "owner_id": current["id"]}, {"_id": 0})
    if not member:
        raise HTTPException(status_code=404, detail="Member not found")
    if data.category not in ("medication", "routine"):
        raise HTTPException(status_code=400, detail="category must be medication or routine")
    # Validate each time format HH:MM
    for slot in data.times:
        if parse_hhmm(slot.time) is None:
            raise HTTPException(status_code=400, detail=f"Invalid time format: {slot.time}")
    times = data.times or []
    rem = Reminder(
        owner_id=current["id"], member_id=data.member_id, member_name=member["name"],
        category=data.category, title=data.title, dosage=data.dosage,
        times=times, time=times[0].time if times else "",
    )
    await db.reminders.insert_one(rem.model_dump())
    return rem


@api_router.put("/reminders/{reminder_id}", response_model=Reminder)
async def update_reminder(reminder_id: str, data: ReminderUpdate, current=Depends(get_current_user)):
    rem = await db.reminders.find_one({"id": reminder_id, "owner_id": current["id"]}, {"_id": 0})
    if not rem:
        raise HTTPException(status_code=404, detail="Reminder not found")
    update: dict = {}
    if data.title is not None:
        update["title"] = data.title
    if data.dosage is not None:
        update["dosage"] = data.dosage
    if data.times is not None:
        for slot in data.times:
            if parse_hhmm(slot.time) is None:
                raise HTTPException(status_code=400, detail=f"Invalid time format: {slot.time}")
        update["times"] = [s.model_dump() for s in data.times]
        update["time"] = data.times[0].time if data.times else ""
    if update:
        await db.reminders.update_one({"id": reminder_id}, {"$set": update})
    doc = await db.reminders.find_one({"id": reminder_id}, {"_id": 0})
    return Reminder.model_validate(doc)


@api_router.post("/reminders/{reminder_id}/mark")
async def mark_reminder(reminder_id: str, body: ReminderMark, current=Depends(get_current_user)):
    if body.status not in ("taken", "missed", "pending"):
        raise HTTPException(status_code=400, detail="invalid status")
    rem = await db.reminders.find_one({"id": reminder_id, "owner_id": current["id"]}, {"_id": 0})
    if not rem:
        raise HTTPException(status_code=404, detail="Reminder not found")
    now = datetime.now(timezone.utc)
    today = local_today_str(current)
    await db.reminders.update_one(
        {"id": reminder_id},
        {"$set": {
            "status": body.status,
            "taken": body.status == "taken",
            "last_marked_at": now,
            "last_marked_date": today,
        }}
    )
    # Log every mark for medication history
    await db.medication_logs.insert_one({
        "id": str(uuid.uuid4()),
        "owner_id": current["id"],
        "reminder_id": reminder_id,
        "member_id": rem["member_id"],
        "category": rem.get("category", "medication"),
        "title": rem["title"],
        "status": body.status,
        "marked_at": now,
        "local_date": today,
    })

    if body.status == "missed":
        recent = await db.alerts.find_one({
            "owner_id": current["id"], "member_id": rem["member_id"],
            "type": rem.get("category", "medication"),
            "created_at": {"$gte": now - timedelta(hours=1)},
            "title": {"$regex": rem["title"]},
        })
        if not recent:
            atype = "medication" if rem.get("category") == "medication" else "routine"
            label = "Medication" if atype == "medication" else "Routine"
            a = Alert(
                owner_id=current["id"], member_id=rem["member_id"], member_name=rem["member_name"],
                type=atype, severity="warning",
                title=f"{label} missed: {rem['title']}",
                message=f"{rem['member_name']} missed {rem['title']}" + (f" ({rem.get('dosage')})" if rem.get('dosage') else "") + ".",
            )
            await db.alerts.insert_one(a.model_dump())
            await push_to_user(
                current["id"],
                f"💊 {rem['member_name']} missed {rem['title']}",
                a.message,
                {"type": atype, "member_id": rem["member_id"], "reminder_id": reminder_id},
            )
    return {"ok": True, "status": body.status}


@api_router.post("/reminders/{reminder_id}/toggle")
async def toggle_reminder(reminder_id: str, current=Depends(get_current_user)):
    rem = await db.reminders.find_one({"id": reminder_id, "owner_id": current["id"]}, {"_id": 0})
    if not rem:
        raise HTTPException(status_code=404, detail="Reminder not found")
    new_taken = not rem.get("taken", False)
    await db.reminders.update_one(
        {"id": reminder_id},
        {"$set": {"taken": new_taken, "status": "taken" if new_taken else "pending",
                  "last_marked_at": datetime.now(timezone.utc),
                  "last_marked_date": local_today_str(current)}}
    )
    return {"ok": True, "taken": new_taken}


@api_router.delete("/reminders/{reminder_id}")
async def delete_reminder(reminder_id: str, current=Depends(get_current_user)):
    r = await db.reminders.delete_one({"id": reminder_id, "owner_id": current["id"]})
    if r.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Reminder not found")
    return {"ok": True}


# ========== Medication history / weekly compliance ==========
@api_router.get("/history/member/{member_id}")
async def member_history(member_id: str, days: int = 7, current=Depends(get_current_user)):
    days = max(1, min(days, 30))
    member = await db.members.find_one({"id": member_id, "owner_id": current["id"]}, {"_id": 0})
    if not member:
        raise HTTPException(status_code=404, detail="Member not found")
    tz = user_tz(current)
    today = datetime.now(tz).date()
    start_date = today - timedelta(days=days - 1)
    start_dt_local = datetime(start_date.year, start_date.month, start_date.day, tzinfo=tz)
    start_dt_utc = start_dt_local.astimezone(timezone.utc)

    logs = await db.medication_logs.find({
        "owner_id": current["id"], "member_id": member_id, "category": "medication",
        "marked_at": {"$gte": start_dt_utc},
    }, {"_id": 0}).to_list(5000)

    # bucket by local_date
    by_date = {}
    for i in range(days):
        d = (start_date + timedelta(days=i)).isoformat()
        by_date[d] = {"date": d, "taken": 0, "missed": 0, "total": 0}
    for log in logs:
        d = log.get("local_date")
        if not d or d not in by_date:
            # fallback to marked_at converted to local
            marked = log.get("marked_at")
            if marked:
                d = marked.astimezone(tz).date().isoformat()
        if d in by_date:
            if log["status"] == "taken":
                by_date[d]["taken"] += 1
                by_date[d]["total"] += 1
            elif log["status"] == "missed":
                by_date[d]["missed"] += 1
                by_date[d]["total"] += 1

    series = [by_date[(start_date + timedelta(days=i)).isoformat()] for i in range(days)]
    total_taken = sum(d["taken"] for d in series)
    total_missed = sum(d["missed"] for d in series)
    total = total_taken + total_missed
    compliance = round((total_taken / total) * 100) if total > 0 else 0

    return {
        "member_id": member_id,
        "member_name": member["name"],
        "days": days,
        "series": series,
        "totals": {"taken": total_taken, "missed": total_missed, "logged": total},
        "compliance_percent": compliance,
        "timezone": current.get("timezone") or "UTC",
    }


# ========== Check-ins ==========
@api_router.post("/checkins", response_model=CheckIn)
async def create_checkin(data: CheckInCreate, current=Depends(get_current_user)):
    member = await db.members.find_one({"id": data.member_id, "owner_id": current["id"]}, {"_id": 0})
    if not member:
        raise HTTPException(status_code=404, detail="Member not found")
    ci = CheckIn(
        owner_id=current["id"], member_id=data.member_id, member_name=member["name"],
        location_name=data.location_name, latitude=data.latitude, longitude=data.longitude,
    )
    await db.checkins.insert_one(ci.model_dump())
    update = {"last_seen": datetime.now(timezone.utc), "status": "healthy"}
    if data.location_name:
        update["location_name"] = data.location_name
    if data.latitude is not None and data.longitude is not None:
        update["latitude"] = data.latitude
        update["longitude"] = data.longitude
    await db.members.update_one({"id": data.member_id}, {"$set": update})
    # Ack today's missed-checkin alerts (using user tz)
    tz = user_tz(current)
    now_local = datetime.now(tz)
    day_start_utc = datetime(now_local.year, now_local.month, now_local.day, tzinfo=tz).astimezone(timezone.utc)
    await db.alerts.update_many(
        {"owner_id": current["id"], "member_id": data.member_id,
         "type": "missed_checkin", "created_at": {"$gte": day_start_utc}},
        {"$set": {"acknowledged": True}}
    )
    return ci


@api_router.get("/checkins/member/{member_id}", response_model=List[CheckIn])
async def list_member_checkins(member_id: str, current=Depends(get_current_user)):
    docs = await db.checkins.find(
        {"owner_id": current["id"], "member_id": member_id}, {"_id": 0}
    ).sort("created_at", -1).to_list(100)
    return [CheckIn(**d) for d in docs]


@api_router.get("/checkins/recent")
async def list_recent_checkins(current=Depends(get_current_user)):
    tz = user_tz(current)
    now_local = datetime.now(tz)
    day_start_utc = datetime(now_local.year, now_local.month, now_local.day, tzinfo=tz).astimezone(timezone.utc)
    docs = await db.checkins.find(
        {"owner_id": current["id"], "created_at": {"$gte": day_start_utc}}, {"_id": 0}
    ).sort("created_at", -1).to_list(200)
    return [CheckIn(**d) for d in docs]


# ========== Billing (Stripe) ==========
class CheckoutRequest(BaseModel):
    success_url: Optional[str] = None
    cancel_url: Optional[str] = None


def _billing_required():
    if not billing.is_configured():
        raise HTTPException(status_code=503, detail="Billing is not configured")


@api_router.get("/billing/status")
async def billing_status(current=Depends(get_current_user)):
    return await billing.build_status_payload(current, db)


@api_router.post("/billing/checkout-session")
async def billing_checkout_session(payload: CheckoutRequest, current=Depends(get_current_user)):
    _billing_required()
    if billing.is_paid(current):
        raise HTTPException(status_code=400, detail="Already on the Family Plan")
    base = (os.environ.get("EXPO_BACKEND_URL") or "").rstrip("/")
    # Fallback: caller-provided URLs (Expo frontend usually sets these to the public preview URL).
    default_success = payload.success_url or f"{base}/billing-success?session_id={{CHECKOUT_SESSION_ID}}"
    default_cancel = payload.cancel_url or f"{base}/billing-cancel"
    try:
        url, session_id = await billing.create_checkout_session(
            db, current, default_success, default_cancel
        )
    except stripe.error.StripeError as e:
        logger.error(f"checkout-session stripe error: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    return {
        "checkout_url": url,
        "session_id": session_id,
        "publishable_key": os.environ.get("STRIPE_PUBLISHABLE_KEY") or None,
    }


@api_router.post("/billing/webhook")
async def billing_webhook(request: Request):
    """Stripe webhook handler. Verifies signature when STRIPE_WEBHOOK_SECRET is set."""
    if not billing.is_configured():
        return {"status": "ignored", "reason": "not configured"}
    payload = await request.body()
    sig = request.headers.get("stripe-signature")
    secret = os.environ.get("STRIPE_WEBHOOK_SECRET", "").strip()
    try:
        if secret:
            event = stripe.Webhook.construct_event(payload, sig, secret)
        else:
            event = json.loads(payload)
    except ValueError as e:
        logger.error(f"webhook invalid payload: {e}")
        raise HTTPException(status_code=400, detail="Invalid payload")
    except stripe.error.SignatureVerificationError as e:
        logger.error(f"webhook signature failed: {e}")
        raise HTTPException(status_code=400, detail="Invalid signature")

    etype = event.get("type") if isinstance(event, dict) else getattr(event, "type", None)
    obj = (event.get("data") or {}).get("object") if isinstance(event, dict) else event["data"]["object"]
    logger.info(f"stripe webhook: {etype}")
    try:
        if etype == "checkout.session.completed":
            customer_id = obj.get("customer")
            subscription_id = obj.get("subscription")
            user_id = (obj.get("metadata") or {}).get("kinnect_user_id")
            if subscription_id and customer_id:
                sub = stripe.Subscription.retrieve(subscription_id)
                # Resolve user_id from customer if metadata missing
                if not user_id:
                    u = await db.users.find_one(
                        {"subscription.stripe_customer_id": customer_id}, {"_id": 0, "id": 1}
                    )
                    user_id = u and u.get("id")
                if user_id:
                    await billing.apply_subscription_to_user(db, user_id, customer_id, sub)
        elif etype in ("customer.subscription.updated", "customer.subscription.created"):
            customer_id = obj.get("customer")
            user_id = (obj.get("metadata") or {}).get("kinnect_user_id")
            if not user_id and customer_id:
                u = await db.users.find_one(
                    {"subscription.stripe_customer_id": customer_id}, {"_id": 0, "id": 1}
                )
                user_id = u and u.get("id")
            if user_id and customer_id:
                await billing.apply_subscription_to_user(db, user_id, customer_id, obj)
        elif etype == "customer.subscription.deleted":
            customer_id = obj.get("customer")
            if customer_id:
                await billing.revert_user_to_free_by_customer(db, customer_id)
    except Exception as e:
        logger.exception(f"webhook handler failed: {e}")
        return {"status": "error", "message": str(e)}
    return {"status": "ok"}


# ========== SOS ==========
@api_router.post("/sos")
async def trigger_sos(data: SOSRequest, current=Depends(get_current_user)):
    member_name = current["full_name"]
    member_id = data.member_id or current["id"]
    if data.member_id:
        m = await db.members.find_one({"id": data.member_id, "owner_id": current["id"]}, {"_id": 0})
        if m:
            member_name = m["name"]
    tz = user_tz(current)
    now_utc = datetime.now(timezone.utc)
    now_local = now_utc.astimezone(tz)
    timestamp_iso = now_utc.isoformat()
    local_time_str = now_local.strftime('%H:%M %Z, %b %d')

    has_coords = data.latitude is not None and data.longitude is not None
    coord_str = ""
    coord_line = ""
    if has_coords:
        coord_str = f" Location: {data.latitude:.4f}, {data.longitude:.4f}."
        coord_line = f"📍 {data.latitude:.5f}, {data.longitude:.5f}"
    else:
        coord_line = "📍 Location unavailable"

    alert = Alert(
        owner_id=current["id"], member_id=member_id, member_name=member_name,
        type="sos", severity="critical",
        title=f"SOS Emergency — {member_name}",
        message=f"{member_name} triggered SOS at {local_time_str}.{coord_str} Emergency services notified.",
        latitude=data.latitude, longitude=data.longitude,
    )
    await db.alerts.insert_one(alert.model_dump())

    # Enhanced push: notify ALL devices on the family account with member name + GPS + timestamp.
    fall_prefix = "Fall detected · " if data.fall_detected else ""
    push_title = f"🆘 {fall_prefix}SOS — {member_name}"
    push_body = f"{coord_line}\n🕒 {local_time_str}\nTap to view & respond."
    push_data = {
        "type": "sos",
        "alert_id": alert.id,
        "member_id": member_id,
        "member_name": member_name,
        "latitude": data.latitude,
        "longitude": data.longitude,
        "timestamp": timestamp_iso,
        "fall_detected": bool(data.fall_detected),
    }
    devices_notified = await push_to_user(current["id"], push_title, push_body, push_data)

    return {
        "ok": True,
        "alert_id": alert.id,
        "emergency_number": "911",
        "timestamp": timestamp_iso,
        "member_name": member_name,
        "coordinates": (
            {"latitude": data.latitude, "longitude": data.longitude} if has_coords else None
        ),
        "devices_notified": devices_notified,
    }


# ========== Dashboard summary ==========
@api_router.get("/summary")
async def dashboard_summary(current=Depends(get_current_user)):
    await reset_daily_reminder_statuses(current["id"])
    await detect_missed_checkins(current["id"])
    tz = user_tz(current)
    now_local = datetime.now(tz)
    day_start_utc = datetime(now_local.year, now_local.month, now_local.day, tzinfo=tz).astimezone(timezone.utc)
    # 7-day window start for compliance
    week_start_local = datetime(now_local.year, now_local.month, now_local.day, tzinfo=tz) - timedelta(days=6)
    week_start_utc = week_start_local.astimezone(timezone.utc)

    members = await db.members.find({"owner_id": current["id"]}, {"_id": 0}).to_list(500)
    rems = await db.reminders.find({"owner_id": current["id"]}, {"_id": 0}).to_list(2000)
    cis = await db.checkins.find(
        {"owner_id": current["id"], "created_at": {"$gte": day_start_utc}}, {"_id": 0}
    ).to_list(500)
    week_logs = await db.medication_logs.find(
        {"owner_id": current["id"], "category": "medication", "marked_at": {"$gte": week_start_utc}},
        {"_id": 0},
    ).to_list(5000)

    summary = []
    for m in members:
        mid = m["id"]
        m_meds = [r for r in rems if r["member_id"] == mid and r.get("category", "medication") == "medication"]
        m_routines = [r for r in rems if r["member_id"] == mid and r.get("category") == "routine"]
        med_taken = sum(1 for r in m_meds if r.get("status") == "taken")
        med_missed = sum(1 for r in m_meds if r.get("status") == "missed")
        routine_done = sum(1 for r in m_routines if r.get("status") == "taken")
        last_ci = next((c for c in cis if c["member_id"] == mid), None)
        # weekly compliance for this member
        m_logs = [log for log in week_logs if log["member_id"] == mid]
        wk_taken = sum(1 for log in m_logs if log["status"] == "taken")
        wk_missed = sum(1 for log in m_logs if log["status"] == "missed")
        wk_total = wk_taken + wk_missed
        wk_compliance = round((wk_taken / wk_total) * 100) if wk_total > 0 else None
        summary.append({
            "member_id": mid, "name": m["name"], "role": m["role"], "status": m["status"],
            "medication_total": len(m_meds), "medication_taken": med_taken, "medication_missed": med_missed,
            "routine_total": len(m_routines), "routine_done": routine_done,
            "checked_in_today": last_ci is not None,
            "last_checkin_time": last_ci["created_at"].isoformat() if last_ci else None,
            "daily_checkin_time": m.get("daily_checkin_time"),
            "weekly_compliance_percent": wk_compliance,
            "weekly_logged": wk_total,
        })
    return {"members": summary, "timezone": current.get("timezone") or "UTC"}


@api_router.get("/")
async def root():
    return {"message": "Kinnship API", "status": "ok"}


app.include_router(api_router)

app.add_middleware(
    CORSMiddleware, allow_credentials=True, allow_origins=["*"],
    allow_methods=["*"], allow_headers=["*"],
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@app.on_event("startup")
async def _init_billing():
    if billing.init_stripe():
        logger.info("Stripe initialized.")
    else:
        logger.info("Stripe NOT initialized (no secret key).")


@app.on_event("startup")
async def _migrate_legacy_reminders():
    """One-time backfill for legacy reminder docs missing category/status fields."""
    try:
        await db.reminders.update_many(
            {"category": {"$exists": False}}, {"$set": {"category": "medication"}}
        )
        await db.reminders.update_many(
            {"status": {"$exists": False}}, {"$set": {"status": "pending"}}
        )
        await db.reminders.update_many(
            {"times": {"$exists": False}}, {"$set": {"times": []}}
        )
    except Exception as e:
        logger.warning(f"Legacy reminder migration skipped: {e}")


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
