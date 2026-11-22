FROM python:3.14-slim
WORKDIR /opt/kitchenette
COPY upstream/ ./
RUN pip install --no-cache-dir . && useradd --uid 1000 --create-home kitchenette
ENV KITCHENETTE_SERVER_HOST=0.0.0.0 KITCHENETTE_SERVER_PORT=8765 KITCHENETTE_SERVER_DB_PATH=/data/kitchenette.db KITCHENETTE_SERVER_TIMEZONE=Asia/Shanghai KITCHENETTE_ROLES_DEFAULT=沈屿 KITCHENETTE_WORDS_HUMAN_NAME=言言 TZ=Asia/Shanghai
USER kitchenette
WORKDIR /data
CMD ["kitchenette", "serve"]
