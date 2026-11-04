-- Statistics restart without deleting data: everything opened before settings.stats_since is archive (still in the tables,
-- not counted in the app). Plus the USD/RUB rate (Bank of Russia) for showing results in rubles; display only.
alter table agent_core.settings add column if not exists stats_since timestamptz not null default '2020-01-01 00:00:00+00';
alter table agent_core.settings add column if not exists usdrub_rate numeric;
alter table agent_core.settings add column if not exists usdrub_rate_at timestamptz;
alter table agent_core.settings add column if not exists usdrub_source text;
create index if not exists positions_entry_time_idx on agent_core.positions (entry_time);
