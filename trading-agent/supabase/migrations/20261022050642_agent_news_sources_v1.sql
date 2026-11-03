-- Status table for the news feeds (so a dead or slow source is visible on the dashboard instead of silently missing).
create table agent_core.news_sources (
  source          text primary key,
  url             text not null,
  ok              boolean,
  last_attempt_at timestamptz,
  last_ok_at      timestamptz,
  items_seen      integer,
  items_new       integer,
  error           text
);
alter table agent_core.news_sources enable row level security;
revoke all on agent_core.news_sources from public, anon, authenticated;
