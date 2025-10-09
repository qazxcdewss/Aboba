-- Services catalog per DB Spec
CREATE TABLE IF NOT EXISTS services (
  id BIGSERIAL PRIMARY KEY,
  group_code TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NULL,
  requires_note BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  position SMALLINT NOT NULL DEFAULT 100,
  i18n JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_services_group_code_code ON services(group_code, code);
CREATE INDEX IF NOT EXISTS idx_services_active_group_pos ON services(is_active, group_code, position);

-- Profile selected services (m2m)
CREATE TABLE IF NOT EXISTS profile_services (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL,
  service_id BIGINT NOT NULL,
  note TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT profile_services_profile_fk FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE,
  CONSTRAINT profile_services_service_fk FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_profile_services_pair ON profile_services(profile_id, service_id);
CREATE INDEX IF NOT EXISTS idx_profile_services_profile ON profile_services(profile_id);
CREATE INDEX IF NOT EXISTS idx_profile_services_service ON profile_services(service_id);

-- Custom services (free text)
CREATE TABLE IF NOT EXISTS profile_custom_services (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT profile_custom_services_profile_fk FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_profile_custom_services_profile ON profile_custom_services(profile_id);

-- Prices matrix
CREATE TYPE price_time_band AS ENUM ('day','night');
CREATE TYPE price_visit_type AS ENUM ('incall','outcall');
CREATE TYPE price_unit AS ENUM ('1h','2h','night','other');
CREATE TYPE price_outcall_travel AS ENUM ('none','client_taxi','included');

CREATE TABLE IF NOT EXISTS profile_prices (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL,
  time_band price_time_band NOT NULL,
  visit_type price_visit_type NOT NULL,
  unit price_unit NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency TEXT NOT NULL,
  outcall_travel price_outcall_travel NOT NULL DEFAULT 'none',
  note TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT profile_prices_profile_fk FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_profile_prices_matrix ON profile_prices(profile_id, time_band, visit_type, unit);
CREATE INDEX IF NOT EXISTS idx_profile_prices_profile ON profile_prices(profile_id);
CREATE INDEX IF NOT EXISTS idx_profile_prices_visit_time ON profile_prices(visit_type, time_band);
