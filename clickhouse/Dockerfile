# ClickHouse for the Railway deploy: the stock image plus a low-memory config.
# Railway bills the memory ClickHouse holds, and on this span volume its
# defaults (large caches, ~a dozen internal log tables merging in the
# background) were most of the bill. Built from the repo root (railway.ts).
FROM clickhouse/clickhouse-server:24.8-alpine
COPY clickhouse/config.d/low-memory.xml /etc/clickhouse-server/config.d/low-memory.xml
COPY clickhouse/users.d/low-memory.xml /etc/clickhouse-server/users.d/low-memory.xml
