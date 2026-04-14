# syntax=docker/dockerfile:1.7

FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /kiln-proxy .

FROM scratch
COPY --from=build /kiln-proxy /kiln-proxy
EXPOSE 9100 9101 9102
ENTRYPOINT ["/kiln-proxy"]
