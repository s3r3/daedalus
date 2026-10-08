import asyncio
import base64
from pathlib import Path

import pytest
from fastapi import HTTPException

from api.models import EditConfig, EditRequest
import api.routes.edit as edit_route


def test_edit_route_cleans_input_temp_file_when_output_temp_creation_fails(monkeypatch):
    created_inputs = []
    original_named_temporary_file = edit_route.tempfile.NamedTemporaryFile
    call_count = 0

    def failing_second_named_temporary_file(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            temp_file = original_named_temporary_file(*args, **kwargs)
            created_inputs.append(Path(temp_file.name))
            return temp_file
        raise RuntimeError("output temp failed")

    monkeypatch.setattr(
        edit_route.tempfile, "NamedTemporaryFile", failing_second_named_temporary_file
    )

    request = EditRequest(
        image_base64=base64.b64encode(b"image").decode(),
        instruction="make it blue",
        config=EditConfig(api_key="key", base_url="https://example.test/v1"),
    )

    with pytest.raises(HTTPException):
        asyncio.run(edit_route.edit_image(request))

    assert created_inputs
    assert all(not path.exists() for path in created_inputs)


def test_edit_route_runs_model_edit_in_thread(monkeypatch):
    thread_calls = []

    async def fake_to_thread(func, *args, **kwargs):
        thread_calls.append(func)
        return func(*args, **kwargs)

    class FakeModelRouter:
        def __init__(self, profiles):
            self.profiles = profiles

        def edit_image(self, *, output_path, **kwargs):
            Path(output_path).write_bytes(b"edited")
            return output_path

    monkeypatch.setattr(asyncio, "to_thread", fake_to_thread)
    monkeypatch.setattr(edit_route, "ModelRouter", FakeModelRouter)

    request = EditRequest(
        image_base64=base64.b64encode(b"image").decode(),
        instruction="make it blue",
        config=EditConfig(api_key="key", base_url="https://example.test/v1"),
    )

    response = asyncio.run(edit_route.edit_image(request))

    assert response.success is True
    assert response.image_base64 == base64.b64encode(b"edited").decode()
    assert [getattr(func, "__name__", "") for func in thread_calls] == ["edit_image"]
