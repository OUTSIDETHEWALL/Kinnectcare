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
from datetime import datetime, timedelta, timezone, date
import jwt
from passlib.context import CryptContext


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


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class UserResponse(BaseModel):
    id: str
    email: str
    full_name: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserResponse


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
    daily_checkin_time: Optional[str] = None  # "HH:MM" UTC; null = no daily expectation
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class CheckinSettings(BaseModel):
    daily_checkin_time: Optional[str] = None  # "HH:MM" or null to disable


class Reminder(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    owner_id: str
    member_id: str
    member_name: str
    category: str = "medication"  # "medication" | "routine"
    title: str
    dosage: Optional[str] = None  # e.g. "500mg, 1 pill"
    times: List[str] = Field(default_factory=list)  # ["08:00","13:00"]
    time: str = ""  # legacy single time; mirrors times[0]
    status: str = "pending"  # "pending" | "taken" | "missed"
    taken: bool = False  # legacy
    last_marked_at: Optional[datetime] = None
    last_marked_date: Optional[str] = None  # "YYYY-MM-DD" for daily reset
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class ReminderCreate(BaseModel):
    member_id: str
    title: str
    category: str = "medication"
    dosage: Optional[str] = None
    times: List[str] = Field(default_factory=list)


class ReminderMark(BaseModel):
    status: str  # "taken" | "missed" | "pending"


class Alert(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    owner_id: str
    member_id: str
    member_name: str
    type: str  # "missed_checkin" | "low_battery" | "medication" | "routine" | "sos"
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


# ========== Auth ==========
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


# ========== Helpers ==========
def today_str() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def parse_hhmm(s: str) -> Optional[int]:
    """Return minutes since midnight, or None if invalid."""
    try:
        h, m = s.split(":")
        return int(h) * 60 + int(m)
    except Exception:
        return None


async def reset_daily_reminder_statuses(owner_id: str):
    """If a reminder was last marked on a previous day, reset to pending."""
    today = today_str()
    cursor = db.reminders.find({"owner_id": owner_id, "status": {"$ne": "pending"}}, {"_id": 0})
    docs = await cursor.to_list(2000)
    for d in docs:
        if d.get("last_marked_date") and d["last_marked_date"] != today:
            await db.reminders.update_one(
                {"id": d["id"]},
                {"$set": {"status": "pending", "taken": False}}
            )


async def detect_missed_checkins(owner_id: str):
    """For each member with daily_checkin_time, if past time today and no check-in
    today, create a missed_checkin alert (deduped per day per member)."""
    now = datetime.now(timezone.utc)
    today = now.date().isoformat()
    now_minutes = now.hour * 60 + now.minute

    members = await db.members.find({"owner_id": owner_id, "daily_checkin_time": {"$ne": None}}, {"_id": 0}).to_list(500)
    for m in members:
        t = m.get("daily_checkin_time")
        if not t:
            continue
        expected = parse_hhmm(t)
        if expected is None or now_minutes < expected:
            continue
        # Check if there's a check-in today
        start = datetime(now.year, now.month, now.day, tzinfo=timezone.utc)
        has_ci = await db.checkins.find_one({"owner_id": owner_id, "member_id": m["id"], "created_at": {"$gte": start}})
        if has_ci:
            continue
        # Check existing alert
        existing = await db.alerts.find_one({
            "owner_id": owner_id, "member_id": m["id"], "type": "missed_checkin", "created_at": {"$gte": start}
        })
        if existing:
            continue
        a = Alert(
            owner_id=owner_id, member_id=m["id"], member_name=m["name"],
            type="missed_checkin", severity="critical",
            title=f"{m['name']} missed daily check-in",
            message=f"Expected by {t} UTC today. They haven't checked in yet.",
        )
        await db.alerts.insert_one(a.model_dump())
        # bump member status
        await db.members.update_one({"id": m["id"]}, {"$set": {"status": "warning"}})


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
@api_router.post("/auth/signup", response_model=TokenResponse)
async def signup(data: UserSignup):
    if await db.users.find_one({"email": data.email.lower()}):
        raise HTTPException(status_code=409, detail="Email already registered")
    user_id = str(uuid.uuid4())
    await db.users.insert_one({
        "id": user_id, "email": data.email.lower(), "full_name": data.full_name,
        "hashed_password": hash_password(data.password),
        "created_at": datetime.now(timezone.utc),
    })
    await seed_demo_data(user_id)
    return TokenResponse(
        access_token=create_access_token(user_id),
        user=UserResponse(id=user_id, email=data.email.lower(), full_name=data.full_name),
    )


@api_router.post("/auth/login", response_model=TokenResponse)
async def login(data: UserLogin):
    user = await db.users.find_one({"email": data.email.lower()})
    if not user or not verify_password(data.password, user["hashed_password"]):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    return TokenResponse(
        access_token=create_access_token(user["id"]),
        user=UserResponse(id=user["id"], email=user["email"], full_name=user["full_name"]),
    )


@api_router.get("/auth/me", response_model=UserResponse)
async def me(current=Depends(get_current_user)):
    return UserResponse(id=current["id"], email=current["email"], full_name=current["full_name"])


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
    await db.reminders.update_one(
        {"id": reminder_id},
        {"$set": {
            "status": body.status,
            "taken": body.status == "taken",
            "last_marked_at": now,
            "last_marked_date": today_str(),
        }}
    )
    # If marked missed → create alert (dedupe within last hour)
    if body.status == "missed":
        recent = await db.alerts.find_one({
            "owner_id": current["id"], "member_id": rem["member_id"],
            "type": rem["category"], "created_at": {"$gte": now - timedelta(hours=1)},
            "title": {"$regex": rem["title"]},
        })
        if not recent:
            atype = "medication" if rem["category"] == "medication" else "routine"
            label = "Medication" if rem["category"] == "medication" else "Routine"
            a = Alert(
                owner_id=current["id"], member_id=rem["member_id"], member_name=rem["member_name"],
                type=atype, severity="warning",
                title=f"{label} missed: {rem['title']}",
                message=f"{rem['member_name']} missed {rem['title']}" + (f" ({rem.get('dosage')})" if rem.get('dosage') else "") + ".",
            )
            await db.alerts.insert_one(a.model_dump())
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
                  "last_marked_at": datetime.now(timezone.utc), "last_marked_date": today_str()}}
    )
    return {"ok": True, "taken": new_taken}


@api_router.delete("/reminders/{reminder_id}")
async def delete_reminder(reminder_id: str, current=Depends(get_current_user)):
    r = await db.reminders.delete_one({"id": reminder_id, "owner_id": current["id"]})
    if r.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Reminder not found")
    return {"ok": True}


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
    # Acknowledge today's missed_checkin alerts for this member
    start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    await db.alerts.update_many(
        {"owner_id": current["id"], "member_id": data.member_id,
         "type": "missed_checkin", "created_at": {"$gte": start}},
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
    """Return today's check-ins for all members."""
    start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    docs = await db.checkins.find(
        {"owner_id": current["id"], "created_at": {"$gte": start}}, {"_id": 0}
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
    now = datetime.now(timezone.utc)
    coord_str = ""
    if data.latitude is not None and data.longitude is not None:
        coord_str = f" Location: {data.latitude:.4f}, {data.longitude:.4f}."
    alert = Alert(
        owner_id=current["id"], member_id=member_id, member_name=member_name,
        type="sos", severity="critical",
        title=f"SOS Emergency — {member_name}",
        message=f"{member_name} triggered SOS at {now.strftime('%H:%M UTC, %b %d')}.{coord_str} Emergency services notified.",
        latitude=data.latitude, longitude=data.longitude,
    )
    await db.alerts.insert_one(alert.model_dump())
    return {"ok": True, "alert_id": alert.id, "emergency_number": "911"}


# ========== Dashboard summary ==========
@api_router.get("/summary")
async def dashboard_summary(current=Depends(get_current_user)):
    """Return per-member medication summary + check-in status for today."""
    await reset_daily_reminder_statuses(current["id"])
    await detect_missed_checkins(current["id"])
    today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)

    members = await db.members.find({"owner_id": current["id"]}, {"_id": 0}).to_list(500)
    rems = await db.reminders.find({"owner_id": current["id"]}, {"_id": 0}).to_list(2000)
    cis = await db.checkins.find(
        {"owner_id": current["id"], "created_at": {"$gte": today_start}}, {"_id": 0}
    ).to_list(500)

    summary = []
    for m in members:
        mid = m["id"]
        m_meds = [r for r in rems if r["member_id"] == mid and r["category"] == "medication"]
        m_routines = [r for r in rems if r["member_id"] == mid and r["category"] == "routine"]
        med_taken = sum(1 for r in m_meds if r["status"] == "taken")
        med_missed = sum(1 for r in m_meds if r["status"] == "missed")
        routine_done = sum(1 for r in m_routines if r["status"] == "taken")
        last_ci = next((c for c in cis if c["member_id"] == mid), None)
        summary.append({
            "member_id": mid,
            "name": m["name"],
            "role": m["role"],
            "status": m["status"],
            "medication_total": len(m_meds),
            "medication_taken": med_taken,
            "medication_missed": med_missed,
            "routine_total": len(m_routines),
            "routine_done": routine_done,
            "checked_in_today": last_ci is not None,
            "last_checkin_time": last_ci["created_at"].isoformat() if last_ci else None,
            "daily_checkin_time": m.get("daily_checkin_time"),
        })
    return {"members": summary}


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
