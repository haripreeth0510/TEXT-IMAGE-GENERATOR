import uuid
from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, String, Text
from sqlalchemy.dialects.postgresql import UUID

from app.database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


class Generation(Base):
    """
    One row per image produced — whether from Generate, Repaint, or
    Paint & Edit. The actual image bytes live on disk under
    backend/storage/, NOT in the database — only the file path is
    stored here, per the "don't put binaries in Postgres" principle
    from the original blueprint.

    No user/auth association — this is a single local history table
    for the one person running the app.
    """

    __tablename__ = "generations"

    id = Column(UUID(as_uuid=False), primary_key=True, default=_uuid)

    mode = Column(String, nullable=False)  # "generate" | "repaint" | "inpaint"
    prompt = Column(Text, nullable=False)
    image_path = Column(String, nullable=False)  # relative path under storage/
    seconds_taken = Column(String, nullable=True)  # stored as string; display-only

    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))