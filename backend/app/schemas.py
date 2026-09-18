from datetime import datetime

from pydantic import BaseModel


class GenerationHistoryItem(BaseModel):
    id: str
    mode: str
    prompt: str
    image_url: str
    seconds_taken: str | None
    created_at: datetime

    class Config:
        from_attributes = True
