from fastapi import FastAPI, APIRouter, HTTPException, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
import uuid
from pathlib import Path
from pydantic import BaseModel, Field, EmailStr
from typing import List, Optional
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
import jwt
from passlib.context import CryptContext

from expo_push import send_expo_push


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

SECRET_KEY = os.environ.get("JWT_SECRET", "kinnectcare-dev-secret-change-in-prod")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
security = HTTPBearer()

app = FastAPI(title="KinnectCare API")
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


class Reminder(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    owner_id: str
    member_id: str
    member_name: str
    category: str = "medication"
    title: str
    dosage: Optional[str] = None
    times: List[str] = Field(default_factory=list)
    time: str = ""
    status: str = "pending"
    taken: bool = False
    last_marked_at: Optional[datetime] = None
    last_marked_date: Optional[str] = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class ReminderCreate(BaseModel):
    member_id: str
    title: str
    category: str = "medication"
    dosage: Optional[str] = None
    times: List[str] = Field(default_factory=list)


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
        return int(h) * 60 + int(m)
    except Exception:
        return None


async def push_to_user(user_id: str, title: str, body: str, data: dict):
    """Send push to all registered push tokens for a user. Best-effort."""
    user = await db.users.find_one({"id": user_id}, {"_id": 0, "push_tokens": 1})
    if not user:
        return
    tokens = user.get("push_tokens") or []
    if tokens:
        await send_expo_push(tokens, title, body, data)


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
                 times=["08:00", "20:00"], time="08:00"),
        Reminder(owner_id=owner_id, member_id=james.id, member_name=james.name,
                 category="medication", title="Lisinopril", dosage="10mg",
                 times=["13:00"], time="13:00"),
        Reminder(owner_id=owner_id, member_id=james.id, member_name=james.name,
                 category="medication", title="Aspirin", dosage="81mg",
                 times=["09:00"], time="09:00"),
    ]
    routines = [
        Reminder(owner_id=owner_id, member_id=james.id, member_name=james.name,
                 category="routine", title="Drink water", times=["10:00", "14:00", "18:00"], time="10:00"),
        Reminder(owner_id=owner_id, member_id=james.id, member_name=james.name,
                 category="routine", title="Morning walk", times=["07:30"], time="07:30"),
        Reminder(owner_id=owner_id, member_id=james.id, member_name=james.name,
                 category="routine", title="Breakfast", times=["08:30"], time="08:30"),
        Reminder(owner_id=owner_id, member_id=james.id, member_name=james.name,
                 category="routine", title="Dinner", times=["19:00"], time="19:00"),
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


# ========== Members ==========
@api_router.get("/members", response_model=List[FamilyMember])
async def list_members(current=Depends(get_current_user)):
    docs = await db.members.find({"owner_id": current["id"]}, {"_id": 0}).to_list(1000)
    return [FamilyMember(**d) for d in docs]


@api_router.post("/members", response_model=FamilyMember)
async def create_member(data: FamilyMemberCreate, current=Depends(get_current_user)):
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
    return [Reminder(**d) for d in docs]


@api_router.get("/reminders/member/{member_id}", response_model=List[Reminder])
async def list_member_reminders(member_id: str, current=Depends(get_current_user)):
    await reset_daily_reminder_statuses(current["id"])
    docs = await db.reminders.find(
        {"owner_id": current["id"], "member_id": member_id}, {"_id": 0}
    ).to_list(2000)
    return [Reminder(**d) for d in docs]


@api_router.post("/reminders", response_model=Reminder)
async def create_reminder(data: ReminderCreate, current=Depends(get_current_user)):
    member = await db.members.find_one({"id": data.member_id, "owner_id": current["id"]}, {"_id": 0})
    if not member:
        raise HTTPException(status_code=404, detail="Member not found")
    if data.category not in ("medication", "routine"):
        raise HTTPException(status_code=400, detail="category must be medication or routine")
    times = data.times or []
    rem = Reminder(
        owner_id=current["id"], member_id=data.member_id, member_name=member["name"],
        category=data.category, title=data.title, dosage=data.dosage,
        times=times, time=times[0] if times else "",
    )
    await db.reminders.insert_one(rem.model_dump())
    return rem


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
    now_local = datetime.now(tz)
    coord_str = ""
    if data.latitude is not None and data.longitude is not None:
        coord_str = f" Location: {data.latitude:.4f}, {data.longitude:.4f}."
    alert = Alert(
        owner_id=current["id"], member_id=member_id, member_name=member_name,
        type="sos", severity="critical",
        title=f"SOS Emergency — {member_name}",
        message=f"{member_name} triggered SOS at {now_local.strftime('%H:%M %Z, %b %d')}.{coord_str} Emergency services notified.",
        latitude=data.latitude, longitude=data.longitude,
    )
    await db.alerts.insert_one(alert.model_dump())
    # Push to family caregivers (owner = same account)
    await push_to_user(
        current["id"],
        f"🆘 SOS — {member_name}",
        alert.message,
        {"type": "sos", "member_id": member_id, "latitude": data.latitude, "longitude": data.longitude},
    )
    return {"ok": True, "alert_id": alert.id, "emergency_number": "911"}


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
        m_meds = [r for r in rems if r["member_id"] == mid and r["category"] == "medication"]
        m_routines = [r for r in rems if r["member_id"] == mid and r["category"] == "routine"]
        med_taken = sum(1 for r in m_meds if r["status"] == "taken")
        med_missed = sum(1 for r in m_meds if r["status"] == "missed")
        routine_done = sum(1 for r in m_routines if r["status"] == "taken")
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
    return {"message": "KinnectCare API", "status": "ok"}


app.include_router(api_router)

app.add_middleware(
    CORSMiddleware, allow_credentials=True, allow_origins=["*"],
    allow_methods=["*"], allow_headers=["*"],
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
