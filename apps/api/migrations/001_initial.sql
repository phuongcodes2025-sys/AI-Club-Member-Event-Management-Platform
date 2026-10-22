CREATE TABLE members (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  name text NOT NULL,
  email text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT 'Member' CHECK (role IN ('Member','Officer','Advisor','Administrator')),
  bio text NOT NULL DEFAULT '',
  interests text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  kind text NOT NULL CHECK (kind IN ('Workshop','Hackathon','Competition','Mentoring','Other')),
  location text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  capacity integer NOT NULL CHECK (capacity > 0 AND capacity <= 100000),
  created_by uuid NOT NULL REFERENCES members(id),
  cancelled_at timestamptz,
  outlook_event_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE TABLE registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id),
  member_id uuid NOT NULL REFERENCES members(id),
  checkin_token uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  checked_in_at timestamptz,
  reminder_queued_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(event_id,member_id)
);
CREATE INDEX registrations_member_idx ON registrations(member_id);
CREATE TABLE notifications (
  id bigserial PRIMARY KEY,
  member_id uuid NOT NULL REFERENCES members(id),
  title text NOT NULL,
  body text NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_member_idx ON notifications(member_id,created_at);
CREATE TABLE jobs (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  unique_key text UNIQUE,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text,
  completed_at timestamptz
);
CREATE INDEX jobs_pending_idx ON jobs(available_at) WHERE completed_at IS NULL;
