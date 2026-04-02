# User Accounts & Thread Assignment

## Summary

Add user accounts to T3 Code so threads (conversations) can be assigned to users. Any user can switch views to see what others are working on. First user becomes admin and can create other accounts. Replaces the nginx basic auth layer with app-level authentication.

## Goals

- Organizational clarity: know who's working on what
- Simple account management: admin creates users, no self-registration
- Trust-based visibility: any user can see/interact with any thread
- Replace nginx basic auth with proper app-level auth

## Non-Goals

- Access control / permissions per thread
- OAuth / SSO / external identity providers
- Multi-tenancy or workspace isolation

---

## Database Schema

### New Tables

#### `users`

| Column        | Type    | Constraints                    |
|---------------|---------|--------------------------------|
| id            | TEXT    | PK, UUID                      |
| username      | TEXT    | UNIQUE, NOT NULL               |
| display_name  | TEXT    | NOT NULL                       |
| password_hash | TEXT    | NOT NULL                       |
| role          | TEXT    | NOT NULL, "admin" or "member"  |
| created_at    | INTEGER | NOT NULL, unix ms              |

#### `user_sessions`

| Column     | Type    | Constraints              |
|------------|---------|--------------------------|
| id         | TEXT    | PK, UUID (= session token) |
| user_id    | TEXT    | FK → users.id, NOT NULL  |
| created_at | INTEGER | NOT NULL, unix ms        |
| expires_at | INTEGER | NOT NULL, unix ms        |

### Schema Changes

#### `projection_threads`

Add column: `assigned_user_id TEXT REFERENCES users(id) ON DELETE SET NULL`

### Migrations

- `020_Users.ts` — creates `users` and `user_sessions` tables
- `021_ThreadAssignment.ts` — adds `assigned_user_id` to `projection_threads`

---

## Auth Flow

### First Run (Setup)

1. Server detects `users` table is empty
2. All routes redirect to `/setup`
3. User fills in: username, display name, password
4. First user is created with role "admin"
5. Auto-login, redirect to main app

### Login

1. User visits `/login`, enters username + password
2. `POST /api/auth/login` validates credentials against argon2 hash
3. On success: create `user_sessions` row, set HTTP-only cookie `t3code_session=<session-id>`
4. Session TTL: 30 days
5. Redirect to main app

### Request Validation

- **HTTP**: Middleware reads `t3code_session` cookie, looks up session, resolves user, attaches to request context. Invalid/expired → 401.
- **WebSocket upgrade**: Same cookie validation during upgrade handshake. Replaces existing basic auth check in `wsServer.ts`. Invalid → reject upgrade.

### Logout

- `POST /api/auth/logout` — delete session row, clear cookie

### Password Hashing

- Library: `@node-rs/argon2`
- Argon2id variant, default cost parameters

---

## API Endpoints

### Auth

| Method | Path               | Auth     | Description                     |
|--------|--------------------|----------|---------------------------------|
| POST   | /api/auth/login    | None     | Login, returns session cookie   |
| POST   | /api/auth/logout   | Required | Logout, clears session          |
| GET    | /api/auth/me       | Required | Current user info               |
| GET    | /api/auth/setup-required | None | Returns `{ required: boolean }` |
| POST   | /api/auth/setup    | None*    | Create admin account (only when no users exist) |

### User Management (Admin)

| Method | Path                | Auth  | Description        |
|--------|---------------------|-------|--------------------|
| GET    | /api/auth/users     | Any   | List all users     |
| POST   | /api/auth/users     | Admin | Create a new user  |
| DELETE | /api/auth/users/:id | Admin | Delete user + sessions |

### WebSocket Methods

| Method       | Description                |
|--------------|----------------------------|
| auth.me      | Current user over WS       |
| users.list   | All users (for assignment) |

---

## Contracts (packages/contracts)

### New Branded Types

```typescript
export const UserId = Schema.String.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type
```

### New Schemas

```typescript
export const UserRole = Schema.Literal("admin", "member")

export const User = Schema.Struct({
  id: UserId,
  username: Schema.String,
  displayName: Schema.String,
  role: UserRole,
  createdAt: Schema.Number,
})

export const AuthSession = Schema.Struct({
  id: Schema.String,
  userId: UserId,
  createdAt: Schema.Number,
  expiresAt: Schema.Number,
})
```

---

## Server Changes

### New: `UserService`

Effect service providing:
- `createUser(username, displayName, password, role)` → User
- `validateCredentials(username, password)` → User | null
- `createSession(userId)` → session token
- `validateSession(token)` → User | null
- `deleteSession(token)` → void
- `listUsers()` → User[]
- `deleteUser(id)` → void
- `getUserCount()` → number (for setup detection)

### Auth Middleware

- Extract from `wsServer.ts` into a dedicated auth module
- HTTP requests: cookie → session lookup → attach user to context
- WS upgrade: cookie → session lookup → attach user to connection state
- Remove all nginx basic auth handling
- Public routes exempted: `/api/auth/login`, `/api/auth/setup`, `/api/auth/setup-required`, static assets

### Thread Assignment Integration

- Thread creation commands accept `assignedUserId` parameter
- Default to current user's ID on thread creation
- Projection snapshot includes `assignedUser` (resolved user object or null)
- New command: `reassignThread(threadId, userId | null)`

### Docker/Deployment

- Remove `T3_WEB_UI_USER` and `T3_WEB_UI_PASSWORD` env vars from docker-compose
- Remove basic auth config from nginx
- nginx becomes a plain reverse proxy + TLS terminator

---

## UI Changes

### New Routes

#### `/setup`

- Shown only when no users exist
- Form: username, display name, password, confirm password
- Creates admin account + auto-login

#### `/login`

- Username + password form
- Error display for invalid credentials
- Redirects to main app on success

### Auth Wrapper

- Root route checks auth state on mount
- If no users exist → redirect to `/setup`
- If not authenticated → redirect to `/login`
- Store current user in React context / Zustand

### Sidebar Changes

- **User indicator** in sidebar footer: current user's display name + logout button
- **Thread filter**: dropdown above thread list with options:
  - "My Threads" (default)
  - "All Threads"
  - Each user by name
- **Thread list items**: small badge/label showing assigned user's display name

### Thread Header

- Assignment dropdown: shows all users + "Unassigned"
- Clicking changes the thread's `assigned_user_id`

### Settings Page

- New "Users" tab (visible to all, editable by admin)
- Admin view: list of users with delete buttons, "Add User" form (username, display name, password)
- Member view: read-only user list

### State Management

- New Zustand slice or store for auth state: `currentUser`, `isAuthenticated`, `isAdmin`
- React Query queries: `useCurrentUser()`, `useUsers()`
- Thread queries updated to include assigned user info

---

## Testing

- Unit tests for `UserService` (password hashing, session lifecycle, role checks)
- Integration tests for auth endpoints (login, logout, setup flow)
- Integration tests for thread assignment (assign, reassign, filter)
- E2E: setup flow → login → create thread → assign → switch user view
