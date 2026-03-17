# API Endpoints

httpbin.org is an HTTP request/response testing service. It renders responses as formatted JSON in the browser.

## Homepage

### Components
- **Swagger UI** — interactive API documentation with collapsible endpoint groups.
- **Heading** — displays the httpbin title/logo.

## GET /get

### Response
- Returns a JSON object with `args`, `headers`, `origin`, and `url` fields.
- `origin` contains the caller's IP address.
- `headers` contains the request headers sent by the browser.

## GET /uuid

### Response
- Returns a JSON object with a single `uuid` field containing a v4 UUID string.
