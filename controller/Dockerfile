FROM golang:1.26-alpine AS build
WORKDIR /src

# Dependencies first, so a code change does not re-download the module cache.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
# Static, so the runtime image can be scratch.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/remuda-controller .

FROM scratch
# Needed to verify the API server's certificate when talking to Rancher.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /out/remuda-controller /remuda-controller
USER 10001:10001
ENTRYPOINT ["/remuda-controller"]
