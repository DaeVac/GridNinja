from typing import Optional, List
from datetime import datetime
from sqlmodel import Field, SQLModel, create_engine, Session, Relationship

# ============================================================
# DB MODELS
# ============================================================

class DecisionRecord(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    decision_id: str = Field(index=True, unique=True)
    ts: datetime = Field(default_factory=datetime.now, index=True)
    
    # Inputs
    requested_kw: float
    site_load_kw: float
    grid_headroom_kw: float
    
    # Outcomes
    approved_kw: float
    blocked: bool
    reason_code: str
    
    # Explainability
    primary_constraint: Optional[str] = None
    constraint_value: Optional[float] = None
    constraint_threshold: Optional[float] = None
    
    # Relationships
    traces: List["TraceRecord"] = Relationship(back_populates="decision")

class TraceRecord(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    decision_id: str = Field(foreign_key="decisionrecord.decision_id")
    ts: datetime = Field(default_factory=datetime.now)
    
    component: str
    rule_id: str
    status: str
    severity: str
    message: str
    
    # Evidence (JSON-like columns simplified for SQLite)
    value: Optional[float] = None
    threshold: Optional[float] = None
    
    decision: DecisionRecord = Relationship(back_populates="traces")

# ============================================================
# SETUP
# ============================================================

sqlite_file_name = "gridninja.db"
sqlite_url = f"sqlite:///{sqlite_file_name}"

engine = create_engine(sqlite_url, echo=False)

def create_db_and_tables():
    SQLModel.metadata.create_all(engine)

def get_session():
    with Session(engine) as session:
        yield session
