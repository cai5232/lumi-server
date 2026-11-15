FROM ghcr.io/astral-sh/uv:0.13.8 AS uv
FROM python:3.12-slim
COPY --from=uv /uv /usr/local/bin/uv
ADD https://codeload.github.com/nnkiirue99-maker/ai-friend-circle/tar.gz/103c85e8e4865dfc82da38d4a59c7d001c234c16 /tmp/friend-circle.tar.gz
WORKDIR /app
RUN tar xzf /tmp/friend-circle.tar.gz --strip-components=1 && rm /tmp/friend-circle.tar.gz \
    && uv sync --locked --no-dev --extra deploy --no-editable
ENV PATH="/app/.venv/bin:${PATH}" PYTHONUNBUFFERED=1
COPY start.py /usr/local/bin/start-friend-circle.py
ENTRYPOINT ["python", "/usr/local/bin/start-friend-circle.py"]
