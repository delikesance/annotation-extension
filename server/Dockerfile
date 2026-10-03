FROM node:22-alpine
WORKDIR /app
COPY gateway.mjs ./
RUN addgroup -S gw && adduser -S gw -G gw && mkdir /data && chown gw:gw /data
USER gw
ENV DATA_DIR=/data PORT=4180 HOST=0.0.0.0
EXPOSE 4180
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:4180/healthz || exit 1
CMD ["node", "gateway.mjs"]
