-- Lets the engine store a per-market assessment (trend, momentum, volatility, signal quality, last closed candle) every minute,
-- independent of whether an agent is running, so the dashboard can rank markets before anything is started.
alter table agent_core.data_status add column assessment jsonb;
