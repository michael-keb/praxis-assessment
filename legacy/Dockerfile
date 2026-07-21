FROM python:3.12-slim
WORKDIR /app
COPY server.py assessment.html ./
ENV DATA_DIR=/data PORT=8080
VOLUME /data
EXPOSE 8080
CMD ["python3", "server.py"]
