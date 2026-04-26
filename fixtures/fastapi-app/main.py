from fastapi import FastAPI
from pydantic import BaseModel, EmailStr, Field
from typing import Optional

app = FastAPI(title="Fixture FastAPI App")


class UserCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    email: EmailStr
    age: Optional[int] = Field(None, ge=0, le=120)


class UserUpdate(BaseModel):
    name: Optional[str] = None
    email: Optional[EmailStr] = None


@app.get("/api/users")
def list_users():
    return {"users": []}


@app.post("/api/users", status_code=201)
def create_user(user: UserCreate):
    return {"user": user.model_dump()}


@app.get("/api/users/{user_id}")
def get_user(user_id: int):
    return {"user": {"id": user_id}}


@app.put("/api/users/{user_id}")
def update_user(user_id: int, user: UserUpdate):
    return {"user": {"id": user_id, **user.model_dump(exclude_none=True)}}


@app.delete("/api/users/{user_id}")
def delete_user(user_id: int):
    return {"deleted": user_id}
