from fastapi import FastAPI, APIRouter, HTTPException, Depends, status
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
import jwt
from passlib.context import CryptContext


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB connection
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

# Auth config
SECRET_KEY = os.environ.get("JWT_SECRET", "kinnectcare-dev-secret-change-in-prod")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7  # 7 days

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
    role: str = "family"  # "family" or "senior"


class FamilyMember(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    owner_id: str
    name: str
    age: int
    phone: str
    gender: str
    role: str  # "family" or "senior"
    status: str = "healthy"  # "healthy", "warning", "critical"
    last_seen: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    location_name: Optional[str] = "Home"
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    avatar_url: Optional[str] = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class Alert(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    owner_id: str
    member_id: str
    member_name: str
    type: str  # "missed_checkin", "low_battery", "medication", "sos"
    severity: str  # "critical", "warning", "info"
    title: str
    message: str
    acknowledged: bool = False
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class Reminder(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    owner_id: str
    member_id: str
    member_name: str
    title: str  # e.g. "Take Metformin"
    time: str  # "08:00"
    taken: bool = False
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class ReminderCreate(BaseModel):
    member_id: str
    title: str
    time: str


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


# ========== Auth helpers ==========
def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def create_access_token(user_id: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    payload = {"sub": user_id, "exp": expire}
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


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


# ========== Seed demo data ==========
async def seed_demo_data(owner_id: str):
    """Seed Gregory (family) and James (senior) for new users."""
    gregory = FamilyMember(
        owner_id=owner_id,
        name="Gregory",
        age=35,
        phone="+1-555-0142",
        gender="Male",
        role="family",
        status="healthy",
        location_name="Downtown Office",
        avatar_url="https://images.unsplash.com/photo-1592234789031-94bf65f630ed?crop=entropy&cs=srgb&fm=jpg&ixid=M3w4NjA1OTN8MHwxfHNlYXJjaHwxfHx5b3VuZyUyMG1hbiUyMHNtaWxpbmclMjBwb3J0cmFpdCUyMHNpbmdsZXxlbnwwfHx8fDE3Nzg1NDE2ODV8MA&ixlib=rb-4.1.0&q=85",
    )
    james = FamilyMember(
        owner_id=owner_id,
        name="James",
        age=78,
        phone="+1-555-0178",
        gender="Male",
        role="senior",
        status="warning",
        location_name="Home",
        avatar_url="https://images.unsplash.com/photo-1667312147803-4b2437b5485e?crop=entropy&cs=srgb&fm=jpg&ixid=M3w4NjA1OTV8MHwxfHNlYXJjaHwxfHxzZW5pb3IlMjBtYW4lMjBwb3J0cmFpdCUyMHNtaWxpbmclMjB3YXJtfGVufDB8fHx8MTc3ODU0MTY4MHww&ixlib=rb-4.1.0&q=85",
    )
    await db.members.insert_many([gregory.model_dump(), james.model_dump()])

    # Reminders for James
    reminders = [
        Reminder(owner_id=owner_id, member_id=james.id, member_name=james.name,
                 title="Take Metformin", time="08:00"),
        Reminder(owner_id=owner_id, member_id=james.id, member_name=james.name,
                 title="Take Blood Pressure Medication", time="13:00"),
        Reminder(owner_id=owner_id, member_id=james.id, member_name=james.name,
                 title="Evening Walk", time="18:00"),
    ]
    await db.reminders.insert_many([r.model_dump() for r in reminders])

    # Alerts
    alerts = [
        Alert(owner_id=owner_id, member_id=james.id, member_name=james.name,
              type="missed_checkin", severity="critical",
              title="Missed morning check-in",
              message=f"{james.name} hasn't checked in today. Last seen 14 hours ago."),
        Alert(owner_id=owner_id, member_id=james.id, member_name=james.name,
              type="low_battery", severity="warning",
              title="Low battery on James's device",
              message="Battery level is 15%. Please remind him to charge."),
        Alert(owner_id=owner_id, member_id=james.id, member_name=james.name,
              type="medication", severity="warning",
              title="Medication reminder",
              message="James missed his 8:00 AM Metformin."),
    ]
    await db.alerts.insert_many([a.model_dump() for a in alerts])


# ========== Auth Routes ==========
@api_router.post("/auth/signup", response_model=TokenResponse)
async def signup(data: UserSignup):
    existing = await db.users.find_one({"email": data.email.lower()})
    if existing:
        raise HTTPException(status_code=409, detail="Email already registered")
    user_id = str(uuid.uuid4())
    user_doc = {
        "id": user_id,
        "email": data.email.lower(),
        "full_name": data.full_name,
        "hashed_password": hash_password(data.password),
        "created_at": datetime.now(timezone.utc),
    }
    await db.users.insert_one(user_doc)
    await seed_demo_data(user_id)
    token = create_access_token(user_id)
    return TokenResponse(
        access_token=token,
        user=UserResponse(id=user_id, email=data.email.lower(), full_name=data.full_name),
    )


@api_router.post("/auth/login", response_model=TokenResponse)
async def login(data: UserLogin):
    user = await db.users.find_one({"email": data.email.lower()})
    if not user or not verify_password(data.password, user["hashed_password"]):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    token = create_access_token(user["id"])
    return TokenResponse(
        access_token=token,
        user=UserResponse(id=user["id"], email=user["email"], full_name=user["full_name"]),
    )


@api_router.get("/auth/me", response_model=UserResponse)
async def me(current=Depends(get_current_user)):
    return UserResponse(id=current["id"], email=current["email"], full_name=current["full_name"])


# ========== Family Members ==========
@api_router.get("/members", response_model=List[FamilyMember])
async def list_members(current=Depends(get_current_user)):
    docs = await db.members.find({"owner_id": current["id"]}, {"_id": 0}).to_list(1000)
    return [FamilyMember(**d) for d in docs]


@api_router.post("/members", response_model=FamilyMember)
async def create_member(data: FamilyMemberCreate, current=Depends(get_current_user)):
    role = data.role if data.role in ("family", "senior") else ("senior" if data.age >= 60 else "family")
    member = FamilyMember(
        owner_id=current["id"],
        name=data.name,
        age=data.age,
        phone=data.phone,
        gender=data.gender,
        role=role,
        status="healthy",
        location_name="Unknown",
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
    result = await db.members.delete_one({"id": member_id, "owner_id": current["id"]})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Member not found")
    return {"ok": True}


@api_router.put("/members/{member_id}/location", response_model=FamilyMember)
async def update_member_location(member_id: str, data: LocationUpdate, current=Depends(get_current_user)):
    update = {
        "latitude": data.latitude,
        "longitude": data.longitude,
        "last_seen": datetime.now(timezone.utc),
    }
    if data.location_name:
        update["location_name"] = data.location_name
    result = await db.members.update_one(
        {"id": member_id, "owner_id": current["id"]}, {"$set": update}
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Member not found")
    doc = await db.members.find_one({"id": member_id}, {"_id": 0})
    return FamilyMember(**doc)


# ========== Alerts ==========
@api_router.get("/alerts", response_model=List[Alert])
async def list_alerts(current=Depends(get_current_user)):
    docs = await db.alerts.find({"owner_id": current["id"]}, {"_id": 0}).sort("created_at", -1).to_list(1000)
    return [Alert(**d) for d in docs]


@api_router.post("/alerts/{alert_id}/ack")
async def acknowledge_alert(alert_id: str, current=Depends(get_current_user)):
    result = await db.alerts.update_one(
        {"id": alert_id, "owner_id": current["id"]}, {"$set": {"acknowledged": True}}
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Alert not found")
    return {"ok": True}


# ========== Reminders ==========
@api_router.get("/reminders", response_model=List[Reminder])
async def list_reminders(current=Depends(get_current_user)):
    docs = await db.reminders.find({"owner_id": current["id"]}, {"_id": 0}).to_list(1000)
    return [Reminder(**d) for d in docs]


@api_router.get("/reminders/member/{member_id}", response_model=List[Reminder])
async def list_member_reminders(member_id: str, current=Depends(get_current_user)):
    docs = await db.reminders.find(
        {"owner_id": current["id"], "member_id": member_id}, {"_id": 0}
    ).to_list(1000)
    return [Reminder(**d) for d in docs]


@api_router.post("/reminders", response_model=Reminder)
async def create_reminder(data: ReminderCreate, current=Depends(get_current_user)):
    member = await db.members.find_one({"id": data.member_id, "owner_id": current["id"]}, {"_id": 0})
    if not member:
        raise HTTPException(status_code=404, detail="Member not found")
    rem = Reminder(
        owner_id=current["id"],
        member_id=data.member_id,
        member_name=member["name"],
        title=data.title,
        time=data.time,
    )
    await db.reminders.insert_one(rem.model_dump())
    return rem


@api_router.post("/reminders/{reminder_id}/toggle")
async def toggle_reminder(reminder_id: str, current=Depends(get_current_user)):
    rem = await db.reminders.find_one({"id": reminder_id, "owner_id": current["id"]}, {"_id": 0})
    if not rem:
        raise HTTPException(status_code=404, detail="Reminder not found")
    new_val = not rem["taken"]
    await db.reminders.update_one({"id": reminder_id}, {"$set": {"taken": new_val}})
    return {"ok": True, "taken": new_val}


# ========== Check-ins ==========
@api_router.post("/checkins", response_model=CheckIn)
async def create_checkin(data: CheckInCreate, current=Depends(get_current_user)):
    member = await db.members.find_one({"id": data.member_id, "owner_id": current["id"]}, {"_id": 0})
    if not member:
        raise HTTPException(status_code=404, detail="Member not found")
    checkin = CheckIn(
        owner_id=current["id"],
        member_id=data.member_id,
        member_name=member["name"],
        location_name=data.location_name,
        latitude=data.latitude,
        longitude=data.longitude,
    )
    await db.checkins.insert_one(checkin.model_dump())
    # Update member's last_seen + status to healthy
    update = {
        "last_seen": datetime.now(timezone.utc),
        "status": "healthy",
    }
    if data.location_name:
        update["location_name"] = data.location_name
    if data.latitude is not None and data.longitude is not None:
        update["latitude"] = data.latitude
        update["longitude"] = data.longitude
    await db.members.update_one({"id": data.member_id}, {"$set": update})
    return checkin


@api_router.get("/checkins/member/{member_id}", response_model=List[CheckIn])
async def list_member_checkins(member_id: str, current=Depends(get_current_user)):
    docs = await db.checkins.find(
        {"owner_id": current["id"], "member_id": member_id}, {"_id": 0}
    ).sort("created_at", -1).to_list(100)
    return [CheckIn(**d) for d in docs]


# ========== SOS ==========
class SOSRequest(BaseModel):
    member_id: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None


@api_router.post("/sos")
async def trigger_sos(data: SOSRequest, current=Depends(get_current_user)):
    member_name = current["full_name"]
    member_id = data.member_id or current["id"]
    if data.member_id:
        m = await db.members.find_one({"id": data.member_id, "owner_id": current["id"]}, {"_id": 0})
        if m:
            member_name = m["name"]
    alert = Alert(
        owner_id=current["id"],
        member_id=member_id,
        member_name=member_name,
        type="sos",
        severity="critical",
        title="🚨 SOS Emergency Triggered",
        message=f"{member_name} activated the SOS emergency button. Emergency services have been notified.",
    )
    await db.alerts.insert_one(alert.model_dump())
    return {"ok": True, "alert_id": alert.id, "emergency_number": "911"}


# ========== Health ==========
@api_router.get("/")
async def root():
    return {"message": "KinnectCare API", "status": "ok"}


app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
