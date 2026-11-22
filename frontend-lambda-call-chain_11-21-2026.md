# Frontend → Lambda call chain and API Gateway routes

Exported on 2026-11-21. This file contains the last three answers about how the React frontend triggers the AWS Lambda BFF, how path matching works, and where to find the routes in AWS.

---

# Answer 1 — How does the frontend JavaScript trigger the AWS Lambda backend?

Good question — this is the key “glue” between the React app and the Lambda BFF.

Short answer: **the frontend does not call AWS Lambda directly**. It makes a normal same-origin HTTPS request to:

```text
https://<portal-host>/api/...
```

API Gateway owns that `/api` path and invokes the Lambda BFF. The browser does not use the AWS SDK, does not know the Lambda ARN, and does not know the API Gateway execute-api URL.

---

## 1. The production call chain

For `vw-baev.de`, the flow is:

```text
Browser / React SPA
https://vw-baev.de
        │
        │ fetch('/api/me')
        │ fetch('/api/auth/login?method=verimi')
        │ fetch('/api/auth/enroll')
        ▼
Same portal domain
https://vw-baev.de/api/*
        │
        │ API Gateway custom domain
        │ BasePathMapping: /api -> BFF HttpApi stage
        ▼
AWS API Gateway HTTP API
Route: GET /auth/login
Route: GET /auth/enroll
Route: GET /auth/callback
Route: GET /auth/logout
Route: GET /me
        │
        │ AWS_PROXY integration
        │ payload format 2.0
        ▼
AWS Lambda BFF
backend/src/handler.js
        │
        ▼
backend/src/router.js
        │
        ├── handlers/login.js
        ├── handlers/enroll.js
        ├── handlers/callback.js
        ├── handlers/me.js
        └── handlers/logout.js
```

The important trick is the **custom domain base path mapping**:

```text
Browser calls:        https://vw-baev.de/api/auth/login
API Gateway routes:   GET /auth/login
Lambda receives:      rawPath = /auth/login
```

The `/api` prefix is stripped by the API Gateway custom-domain mapping.

The backend router also supports `/api/...` as a defensive fallback:

```js
// backend/src/router.js

export function normalizePath(rawPath) {
  let path = String(rawPath || '/');

  if (path === '/api') return '/';
  if (path.startsWith('/api/')) path = path.slice(4);

  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path || '/';
}
```

So both of these work:

```text
/api/auth/login  -> normalized to /auth/login
/auth/login      -> already canonical
```

---

## 2. The frontend code that triggers Lambda

The central frontend file is:

```text
impl-broker-bff/frontend/src/api.ts
```

It contains this function:

```ts
async function get<T>(path: string): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: 'GET',
    credentials: 'include', // send the httpOnly __Host- cookies
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`request_failed_${response.status}`);
  }
  return (await response.json()) as T;
}
```

Then the public API functions are:

```ts
export const getMe = (): Promise<MeResponse> => get<MeResponse>('/me');

export const startLogin = (method: LoginMethod = 'auto'): Promise<AuthorizationUrlResponse> =>
  get<AuthorizationUrlResponse>(`/auth/login?method=${encodeURIComponent(method)}`);

export const startEnrolment = (): Promise<AuthorizationUrlResponse> =>
  get<AuthorizationUrlResponse>('/auth/enroll');
```

Therefore:

| Frontend function | Browser request | Lambda route |
|---|---|---|
| `getMe()` | `GET /api/me` | `GET /me` |
| `startLogin('verimi')` | `GET /api/auth/login?method=verimi` | `GET /auth/login` |
| `startLogin('passkey')` | `GET /api/auth/login?method=passkey` | `GET /auth/login` |
| `startEnrolment()` | `GET /api/auth/enroll` | `GET /auth/enroll` |
| logout button | `GET /api/auth/logout` | `GET /auth/logout` |
| Keycloak callback | `GET /api/auth/callback?code=...&state=...` | `GET /auth/callback` |

---

## 3. Example: user clicks “Mit Verimi anmelden”

Frontend code in `LoginPanel.tsx`:

```tsx
async function handleLogin(method: LoginMethod) {
  setBusyMethod(method);
  setError(null);
  try {
    const { authorizationUrl } = await startLogin(method);

    const target = toKeycloakAuthorizationUrl(authorizationUrl);
    window.location.assign(target.toString());
  } catch {
    setError(ERROR_TEXT[method]);
    setBusyMethod(null);
  }
}
```

Step by step:

```text
1. User clicks "Mit Verimi anmelden"

2. React calls:
   startLogin('verimi')

3. api.ts executes:
   fetch('/api/auth/login?method=verimi', {
     credentials: 'include'
   })

4. Browser sends HTTP GET to:
   https://vw-baev.de/api/auth/login?method=verimi

5. API Gateway custom-domain mapping sees:
   /api base path -> BFF HttpApi

6. API Gateway matches route:
   GET /auth/login

7. API Gateway invokes Lambda:
   BffFunction

8. Lambda entry point:
   backend/src/handler.js

9. router.js selects:
   handlers/login.js

10. login.js creates:
   - encrypted transaction cookie __Host-pk_tx
   - authorizationUrl from openid-client

11. Lambda returns JSON:
   {
     "authorizationUrl": "https://kc.gateway-vw.de:8443/realms/vw-beav/protocol/openid-connect/auth?..."
   }

12. React receives that URL.

13. React checks that the URL points to the expected Keycloak origin.

14. React navigates the browser:
   window.location.assign(authorizationUrl)
```

Only after step 14 does Keycloak appear.

---

## 4. Lambda entry point

The actual Lambda handler is extremely small:

```js
// backend/src/handler.js

/** AWS Lambda entry point (API Gateway HTTP API, payload format 2.0). */
import { route } from './router.js';

export const handler = async (event, context) => route(event, context);
```

API Gateway gives Lambda an `event` object that looks conceptually like this:

```js
{
  rawPath: "/auth/login",
  requestContext: {
    http: {
      method: "GET"
    },
    domainName: "vw-baev.de",
    requestId: "..."
  },
  headers: {
    cookie: "__Host-pksid=...; __Host-pk_enrolled=..."
  },
  queryStringParameters: {
    method: "verimi"
  }
}
```

The router then dispatches:

```js
const routes = [
  ['GET', '/auth/login', login],
  ['GET', '/auth/enroll', enroll],
  ['GET', '/auth/callback', callback],
  ['GET', '/auth/logout', logout],
  ['GET', '/me', me],
];

export async function route(event) {
  const path = normalizePath(event.rawPath || event.path || '/');
  const method = String(
    event.requestContext?.http?.method || event.httpMethod || 'GET'
  ).toUpperCase();

  const match = routes.find(([m, p]) => m === method && p === path);
  if (!match) return response(404, { error: 'not_found' });

  return await match[2](event);
}
```

---

## 5. API Gateway configuration

In `backend/template.yaml`, the HTTP API is defined with the execute-api endpoint disabled:

```yaml
BffHttpApi:
  Type: AWS::ApiGatewayV2::Api
  Properties:
    Name: !Sub '${AWS::StackName}-bff-api'
    ProtocolType: HTTP
    DisableExecuteApiEndpoint: true
```

That means attackers cannot bypass your custom domain by calling some generated URL like:

```text
https://abc123.execute-api.eu-central-1.amazonaws.com/...
```

Only your portal custom domains work.

The integration to Lambda is:

```yaml
BffIntegration:
  Type: AWS::ApiGatewayV2::Integration
  Properties:
    ApiId: !Ref BffHttpApi
    IntegrationType: AWS_PROXY
    IntegrationUri: !Sub 'arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${BffFunction.Arn}/invocations'
    PayloadFormatVersion: '2.0'
```

The routes are concrete and allowlisted:

```yaml
LoginRoute:
  Type: AWS::ApiGatewayV2::Route
  Properties:
    ApiId: !Ref BffHttpApi
    RouteKey: 'GET /auth/login'
    Target: !Sub 'integrations/${BffIntegration}'
```

Same for:

```text
GET /auth/enroll
GET /auth/callback
GET /auth/logout
GET /me
```

There is no wildcard `ANY /{proxy+}` route. That is intentional: fewer attack surfaces.

---

## 6. Custom domain /api mapping

For each portal, `backend/ops/api-domain.template.yaml` creates an API Gateway custom domain and maps `/api` to the BFF stage:

```yaml
PortalApiMapping:
  Type: AWS::ApiGatewayV2::ApiMapping
  Properties:
    ApiId: !Ref HttpApiId
    DomainName: !Ref PortalDomain
    Stage: !Ref ApiStageName
    ApiMappingKey: !Ref BasePath
```

With:

```yaml
BasePath:
  Type: String
  Default: /api
```

So for `vw-baev.de`:

```text
https://vw-baev.de/api/auth/login
                  └── mapped to BFF HttpApi
```

This is why the frontend can simply call `/api/...`.

---

## 7. Why same-origin `/api` is important

The cookies are `__Host-` cookies in production:

```text
__Host-pksid
__Host-pk_tx
__Host-pk_enrolled
```

`__Host-` cookies require:

```text
Secure
Path=/
no Domain attribute
set from HTTPS
```

Because `/api` is on the **same host** as the React app:

```text
https://vw-baev.de/       -> React
https://vw-baev.de/api/   -> Lambda via API Gateway
```

the browser treats both as the same site. It sends the cookies automatically to `/api/...` when `credentials: 'include'` is used.

If instead the frontend called a separate API Gateway URL, e.g.

```text
https://abc123.execute-api.eu-central-1.amazonaws.com
```

then:

- cookies would not be sent to the portal automatically,
- `__Host-` cookies would not be appropriate,
- CORS would be required,
- CSRF handling would become harder,
- the browser would know more infrastructure than necessary.

So same-origin `/api` is a security decision, not just convenience.

---

## 8. Local development: Vite proxy instead of API Gateway

Locally, the React app runs on:

```text
http://localhost:5173
```

The backend local server runs on:

```text
http://localhost:3001
```

In `frontend/vite.config.ts`:

```ts
server: {
  proxy: {
    '/api': {
      target: 'http://localhost:3001',
      changeOrigin: true,
    },
  },
},
```

So locally:

```text
Browser fetch('/api/me')
        │
        ▼
Vite dev server :5173
        │
        │ proxy /api
        ▼
local BFF server :3001
```

The local server converts the Node HTTP request into an API-Gateway-like event:

```js
// backend/src/local-server.js

const event = {
  rawPath: url.pathname,
  requestContext: { http: { method: req.method } },
  headers: req.headers,
  queryStringParameters: Object.fromEntries(url.searchParams.entries()),
  body: null,
};

const result = await route(event);
```

That means the **same backend handlers** run locally and in AWS. Only the “front door” changes:

| Environment | Front door |
|---|---|
| Local | Vite proxy `:5173 -> :3001` |
| Production | API Gateway custom domain `/api` |

---

## 9. The callback is not triggered by React fetch

This is an important distinction.

React triggers:

```text
/api/auth/login
/api/auth/enroll
/api/me
```

But Keycloak triggers the callback:

```text
GET /api/auth/callback?code=...&state=...
```

Keycloak performs a top-level browser redirect:

```text
Browser -> Keycloak -> Browser -> https://vw-baev.de/api/auth/callback?...
```

API Gateway sees that request and invokes Lambda again. The BFF then:

1. opens the encrypted transaction cookie,
2. compares `state`,
3. calls `openid-client.authorizationCodeGrant()`,
4. validates the ID token,
5. creates the portal session,
6. answers with `302 /?login=success`.

Then the React app reloads, calls `/api/me`, and sees the user as authenticated.

---

## 10. Mental model

Think of the frontend as knowing only three things:

```text
1. Call /api/me to ask "who am I?"
2. Call /api/auth/login or /api/auth/enroll to get a Keycloak URL.
3. Navigate the browser to that returned Keycloak URL.
```

The frontend does **not** know:

```text
- client secret
- PKCE verifier
- ID token
- access token
- Keycloak Admin API
- DynamoDB
- AWS Lambda ARN
- API Gateway internal IDs
```

That is exactly what you want for a secure BFF design.

---

# Answer 2 — Does Lambda listen to the last string of the URL path?

Almost — but with one important correction:

> **Lambda does not listen to URL paths.**  
> **API Gateway listens, matches the path, and then invokes Lambda.**

Lambda itself is not a web server in AWS. It sleeps until something invokes it. In this architecture, **API Gateway is the HTTP front door**.

---

## 1. The two routing layers

There are **two separate matching steps**.

### Layer 1: API Gateway route matching

The frontend calls:

```text
GET https://vw-baev.de/api/auth/login?method=verimi
```

API Gateway sees:

```text
Host: vw-baev.de
Path: /api/auth/login
Method: GET
```

The custom domain has a base-path mapping:

```text
/api  ->  BFF HttpApi
```

So API Gateway strips `/api` and internally matches:

```text
GET /auth/login
```

That route is defined in `backend/template.yaml`:

```yaml
LoginRoute:
  Type: AWS::ApiGatewayV2::Route
  Properties:
    ApiId: !Ref BffHttpApi
    RouteKey: 'GET /auth/login'
    Target: !Sub 'integrations/${BffIntegration}'
```

So the route key is not just `"login"`. It is:

```text
GET /auth/login
```

Both the **HTTP method** and the **full path** matter.

---

### Layer 2: Lambda internal router

Once API Gateway matches the route, it invokes the Lambda function.

Lambda receives an event like:

```js
{
  rawPath: "/auth/login",
  requestContext: {
    http: {
      method: "GET"
    }
  },
  queryStringParameters: {
    method: "verimi"
  },
  headers: {
    cookie: "..."
  }
}
```

Then this code runs:

```js
// backend/src/handler.js

export const handler = async (event, context) => route(event, context);
```

Then the router chooses the handler:

```js
// backend/src/router.js

const routes = [
  ['GET', '/auth/login', login],
  ['GET', '/auth/enroll', enroll],
  ['GET', '/auth/callback', callback],
  ['GET', '/auth/logout', logout],
  ['GET', '/me', me],
];

export async function route(event) {
  const path = normalizePath(event.rawPath || event.path || '/');
  const method = String(
    event.requestContext?.http?.method || event.httpMethod || 'GET'
  ).toUpperCase();

  const match = routes.find(([m, p]) => m === method && p === path);
  if (!match) return response(404, { error: 'not_found' });

  return await match[2](event);
}
```

So:

```text
GET /auth/login      -> login(event)
GET /auth/enroll     -> enroll(event)
GET /auth/callback   -> callback(event)
GET /auth/logout     -> logout(event)
GET /me              -> me(event)
```

---

## 2. Exact example

Frontend code:

```ts
startLogin('verimi')
```

calls:

```ts
fetch('/api/auth/login?method=verimi')
```

Browser sends:

```http
GET /api/auth/login?method=verimi HTTP/1.1
Host: vw-baev.de
Cookie: __Host-pksid=...
```

API Gateway:

```text
Custom domain: vw-baev.de
Base path: /api
Remaining path: /auth/login
Route key: GET /auth/login
```

API Gateway invokes Lambda.

Lambda router sees:

```js
path   = "/auth/login"
method = "GET"
```

It selects:

```js
['GET', '/auth/login', login]
```

Then this runs:

```text
backend/src/handlers/login.js
```

---

## 3. Important: query string does not choose the route

This URL:

```text
GET /api/auth/login?method=verimi
```

and this URL:

```text
GET /api/auth/login?method=passkey
```

both hit the **same Lambda route**:

```text
GET /auth/login
```

The difference is only inside the handler:

```js
const requestedMethod =
  String(event.queryStringParameters?.method || 'auto').toLowerCase();
```

So:

```text
route selection:       GET /auth/login
business decision:     method=verimi or method=passkey
```

---

## 4. The `/api` prefix is stripped in production

The browser calls:

```text
/api/auth/login
```

The Lambda route is:

```text
/auth/login
```

Why? Because API Gateway custom-domain base-path mapping does this:

```text
https://vw-baev.de/api/auth/login
                  │
                  │ base path /api stripped by API Gateway
                  ▼
                  /auth/login
```

The backend also has a defensive normalizer:

```js
export function normalizePath(rawPath) {
  let path = String(rawPath || '/');

  if (path === '/api') return '/';
  if (path.startsWith('/api/')) path = path.slice(4);

  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path || '/';
}
```

This means the same Lambda code also works if the path arrives as:

```text
/api/auth/login
```

instead of:

```text
/auth/login
```

That is useful for:

- local development,
- direct Lambda testing,
- different API Gateway mappings.

---

## 5. What happens if the path does not match?

Examples:

```text
POST /api/auth/login
GET  /api/auth/login/extra
GET  /api/unknown
```

At API Gateway level, there is no matching `RouteKey`, so API Gateway returns an error before Lambda is invoked.

If something still reaches the Lambda router with an unknown path, this catches it:

```js
if (!match) return response(404, { error: 'not_found' });
```

So there are two layers of 404 protection.

---

## 6. Local development is different

Locally there is no API Gateway.

```text
Browser :5173
   │
   │ fetch('/api/auth/login')
   ▼
Vite dev server :5173
   │
   │ proxy
   ▼
Node local server :3001
   │
   │ builds fake API Gateway event
   ▼
same router.js
```

In `frontend/vite.config.ts`:

```ts
proxy: {
  '/api': {
    target: 'http://localhost:3001',
    changeOrigin: true,
  },
},
```

So locally, Vite pretends to be API Gateway.

In production, real API Gateway does the job.

---

## 7. Correct mental model

Think of it like this:

```text
Frontend:
  "I need to call /api/auth/login."

Browser:
  "I will send HTTPS GET to https://vw-baev.de/api/auth/login."

API Gateway:
  "I own /api on vw-baev.de. I see GET /auth/login. That route invokes the BFF Lambda."

Lambda:
  "I received an event. rawPath is /auth/login. I will call login()."

login.js:
  "The user asked for method=verimi or method=passkey. I will create the correct Keycloak authorization URL."
```

So your sentence can be refined to:

> The frontend calls `/api/auth/login`. API Gateway matches the full route `GET /auth/login` and invokes the Lambda. Inside Lambda, the router looks at `event.rawPath` and calls the handler assigned to that path.

That is the accurate version.

---

# Answer 3 — Where in AWS can I see the routes?

You see them in **API Gateway**, not directly in Lambda.

Important distinction:

```text
API Gateway route:
  GET /auth/login

Browser URL:
  https://vw-baev.de/api/auth/login

Custom domain mapping:
  vw-baev.de + /api -> BFF HTTP API
```

---

## 1. AWS Console: where to click

Go to the AWS Console in the same region where you deployed the BFF, probably `eu-central-1`.

### Step-by-step

```text
AWS Console
  └─ API Gateway
      └─ APIs
          └─ HTTP API
              └─ <your-stack-name>-bff-api
                  ├─ Routes
                  ├─ Integrations
                  └─ Custom domains
```

The API name comes from `backend/template.yaml`:

```yaml
BffHttpApi:
  Type: AWS::ApiGatewayV2::Api
  Properties:
    Name: !Sub '${AWS::StackName}-bff-api'
```

So if your SAM stack is called:

```text
vw-passkey-bff-prod
```

then the API is called:

```text
vw-passkey-bff-prod-bff-api
```

Inside **Routes**, you should see entries like:

```text
GET /auth/login
GET /auth/enroll
GET /auth/callback
GET /auth/logout
GET /me
```

Those are the current routes from your CloudFormation template.

---

## 2. The source of truth is the template

In this project, you should treat this file as the source of truth:

```text
impl-broker-bff/backend/template.yaml
```

The routes are here:

```yaml
LoginRoute:
  Type: AWS::ApiGatewayV2::Route
  Properties:
    ApiId: !Ref BffHttpApi
    RouteKey: 'GET /auth/login'
    Target: !Sub 'integrations/${BffIntegration}'

EnrollRoute:
  Type: AWS::ApiGatewayV2::Route
  Properties:
    ApiId: !Ref BffHttpApi
    RouteKey: 'GET /auth/enroll'
    Target: !Sub 'integrations/${BffIntegration}'

CallbackRoute:
  Type: AWS::ApiGatewayV2::Route
  Properties:
    ApiId: !Ref BffHttpApi
    RouteKey: 'GET /auth/callback'
    Target: !Sub 'integrations/${BffIntegration}'

LogoutRoute:
  Type: AWS::ApiGatewayV2::Route
  Properties:
    ApiId: !Ref BffHttpApi
    RouteKey: 'GET /auth/logout'
    Target: !Sub 'integrations/${BffIntegration}'

MeRoute:
  Type: AWS::ApiGatewayV2::Route
  Properties:
    ApiId: !Ref BffHttpApi
    RouteKey: 'GET /me'
    Target: !Sub 'integrations/${BffIntegration}'
```

All routes point to the same integration:

```yaml
BffIntegration:
  Type: AWS::ApiGatewayV2::Integration
  Properties:
    ApiId: !Ref BffHttpApi
    IntegrationType: AWS_PROXY
    IntegrationUri: !Sub 'arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${BffFunction.Arn}/invocations'
    PayloadFormatVersion: '2.0'
```

That integration means:

```text
API Gateway route -> invoke BFF Lambda
```

---

## 3. CloudFormation Console view

You can also see the routes as CloudFormation resources.

```text
AWS Console
  └─ CloudFormation
      └─ Stacks
          └─ <your stack>
              └─ Resources
```

Filter for:

```text
Route
```

You should see logical resources like:

```text
LoginRoute
EnrollRoute
CallbackRoute
LogoutRoute
MeRoute
```

Also look for:

```text
BffHttpApi
BffIntegration
BffFunction
BffLambdaPermission
BffStage
```

---

## 4. Lambda Console view

If you go to:

```text
Lambda
  └─ Functions
      └─ <your BFF function>
          └─ Configuration
              └─ Triggers
```

you should see API Gateway as a trigger.

But Lambda does **not** store the path routes. Lambda only has a permission allowing API Gateway to invoke it:

```yaml
BffLambdaPermission:
  Type: AWS::Lambda::Permission
  Properties:
    Action: lambda:InvokeFunction
    FunctionName: !Ref BffFunction
    Principal: apigateway.amazonaws.com
    SourceArn: !Sub 'arn:aws:execute-api:${AWS::Region}:${AWS::AccountId}:${BffHttpApi}/*'
```

So if you ask “where are the paths?”, the answer is:

```text
API Gateway Routes
```

not Lambda.

---

## 5. Custom domain mapping is separate

The routes are not the same thing as the custom domain mapping.

This file:

```text
impl-broker-bff/backend/ops/api-domain.template.yaml
```

contains the mapping:

```yaml
PortalApiMapping:
  Type: AWS::ApiGatewayV2::ApiMapping
  Properties:
    ApiId: !Ref HttpApiId
    DomainName: !Ref PortalDomain
    Stage: !Ref ApiStageName
    ApiMappingKey: !Ref BasePath
```

with:

```yaml
BasePath:
  Type: String
  Default: /api
```

That means:

```text
https://vw-baev.de/api/auth/login
                  │
                  │ API mapping /api
                  ▼
API Gateway route GET /auth/login
```

So:

| Thing | Example | Where defined |
|---|---|---|
| Browser URL | `/api/auth/login` | frontend `fetch()` |
| Domain mapping | `vw-baev.de + /api` | `api-domain.template.yaml` |
| API route | `GET /auth/login` | `backend/template.yaml` |
| Lambda handler route | `['GET', '/auth/login', login]` | `backend/src/router.js` |

---

## 6. CLI commands to inspect routes

First get the API ID.

If you deployed with CloudFormation/SAM, the HTTP API ID is in the stack output:

```bash
export STACK_NAME='<your-stack-name>'

export API_ID="$(
  aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='HttpApiId'].OutputValue" \
    --output text
)"

echo "$API_ID"
```

Then list routes:

```bash
aws apigatewayv2 get-routes \
  --api-id "$API_ID" \
  --query 'Items[].[RouteKey,RouteId,Target]' \
  --output table
```

Expected output shape:

```text
GET /auth/login     abcd123     integrations/xyz789
GET /auth/enroll    efgh456     integrations/xyz789
GET /auth/callback  ijkl789     integrations/xyz789
GET /auth/logout    mnop012     integrations/xyz789
GET /me             qrst345     integrations/xyz789
```

List integrations:

```bash
aws apigatewayv2 get-integrations \
  --api-id "$API_ID" \
  --query 'Items[].[IntegrationId,IntegrationType,IntegrationUri]' \
  --output table
```

List custom domains:

```bash
aws apigatewayv2 get-domain-names \
  --query 'Items[].[DomainName,DomainNameId]' \
  --output table
```

List mappings for one portal domain:

```bash
aws apigatewayv2 get-api-mappings \
  --domain-name 'vw-baev.de' \
  --query 'Items[].[ApiMappingId,ApiId,Stage,ApiMappingKey]' \
  --output table
```

Expected:

```text
<id>    <api-id>    $default    /api
```

---

## 7. If you add a new route, you need to update both places

For example, if you want:

```text
GET /api/health
```

you need:

### A. API Gateway route

In `backend/template.yaml`:

```yaml
HealthRoute:
  Type: AWS::ApiGatewayV2::Route
  Properties:
    ApiId: !Ref BffHttpApi
    RouteKey: 'GET /health'
    Target: !Sub 'integrations/${BffIntegration}'
```

Also add it to the stage `DependsOn`:

```yaml
BffStage:
  Type: AWS::ApiGatewayV2::Stage
  DependsOn:
    - LoginRoute
    - EnrollRoute
    - CallbackRoute
    - LogoutRoute
    - MeRoute
    - HealthRoute
```

### B. Lambda router route

In `backend/src/router.js`:

```js
import { health } from './handlers/health.js';

const routes = [
  ['GET', '/auth/login', login],
  ['GET', '/auth/enroll', enroll],
  ['GET', '/auth/callback', callback],
  ['GET', '/auth/logout', logout],
  ['GET', '/me', me],
  ['GET', '/health', health],
];
```

### C. Frontend call

In `frontend/src/api.ts`:

```ts
export const getHealth = (): Promise<{ ok: boolean }> =>
  get<{ ok: boolean }>('/health');
```

That calls:

```text
/api/health
```

API Gateway maps it to:

```text
GET /health
```

Lambda calls:

```js
health(event)
```

You do **not** need a new custom domain mapping if the route stays under `/api`.

---

## 8. Do not manually add routes only in the AWS Console

You can use the Console to **view** routes.

But for production, add routes in:

```text
backend/template.yaml
backend/src/router.js
```

Then deploy again with SAM/CloudFormation.

If you only click in the Console, the next deploy may remove your manual route because CloudFormation will restore the stack to match the template. This is called **configuration drift**.

---

If you tell me the new route, for example:

```text
GET /api/portal/config
```

I can show you the exact code changes for:

```text
frontend/src/api.ts
backend/src/router.js
backend/src/handlers/...
backend/template.yaml
```
