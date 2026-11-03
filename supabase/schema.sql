-- 비플페이 식당 지도 스키마
-- Supabase 대시보드 → SQL Editor에 통째로 붙여 넣고 실행한다

-- 구획 요청과 수집 결과
create table if not exists public.regions (
  id           uuid primary key default gen_random_uuid(),
  query        text not null,                       -- 사용자가 입력한 원문
  name         text not null,                       -- 해석된 구획명 (예: 역삼1동, 테헤란로, 강남역)
  kind         text not null check (kind in ('admin', 'road', 'poi')),
  keyword      text not null default '',            -- 업종 키워드 (예: 국밥). 없으면 빈 문자열
  polygon      jsonb,                               -- GeoJSON Polygon / MultiPolygon, 좌표는 [경도, 위도]
  center_lat   double precision,
  center_lng   double precision,
  status       text not null default 'pending'
               check (status in ('pending', 'collecting', 'done', 'failed')),
  error        text,
  created_at   timestamptz not null default now(),
  collected_at timestamptz,
  unique (name, kind, keyword)
);

-- 구획별 업장 목록
create table if not exists public.restaurants (
  id         uuid primary key default gen_random_uuid(),
  region_id  uuid not null references public.regions (id) on delete cascade,
  place_key  text not null,                         -- 상가정보 상가업소번호(bizesId). 비플페이 상태를 묶는 키
  name       text not null,
  category   text,
  address    text,
  lat        double precision not null,
  lng        double precision not null,
  created_at timestamptz not null default now(),
  unique (region_id, place_key)
);
create index if not exists restaurants_place_key_idx on public.restaurants (place_key);

-- 업장별 비플페이 최신 상태 (마지막 응답이 이긴다)
create table if not exists public.bipl_status (
  place_key  text primary key,
  status     text not null check (status in ('yes', 'no')),
  updated_at timestamptz not null default now()
);

-- 응답 이력 (장난 입력을 되돌릴 때 참고)
create table if not exists public.bipl_votes (
  id         bigint generated always as identity primary key,
  place_key  text not null,
  status     text not null check (status in ('yes', 'no')),
  created_at timestamptz not null default now()
);

-- 익명 사용자가 상태를 바꾸는 유일한 통로
create or replace function public.set_bipl(p_place_key text, p_status text)
returns public.bipl_status
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.bipl_status;
begin
  if p_status not in ('yes', 'no') then
    raise exception 'status는 yes 또는 no 여야 합니다';
  end if;
  -- 수집된 적 없는 업장 키는 거부한다
  if not exists (select 1 from public.restaurants where place_key = p_place_key) then
    raise exception '존재하지 않는 업장입니다: %', p_place_key;
  end if;

  insert into public.bipl_status (place_key, status, updated_at)
  values (p_place_key, p_status, now())
  on conflict (place_key) do update
    set status = excluded.status, updated_at = excluded.updated_at
  returning * into result;

  insert into public.bipl_votes (place_key, status) values (p_place_key, p_status);
  return result;
end;
$$;

revoke all on function public.set_bipl(text, text) from public;
grant execute on function public.set_bipl(text, text) to anon, authenticated;

-- RLS: 익명은 읽기만. 쓰기는 service role(서버 · 수집기)과 set_bipl 함수만
alter table public.regions     enable row level security;
alter table public.restaurants enable row level security;
alter table public.bipl_status enable row level security;
alter table public.bipl_votes  enable row level security;

drop policy if exists "regions 읽기" on public.regions;
create policy "regions 읽기" on public.regions for select to anon, authenticated using (true);

drop policy if exists "restaurants 읽기" on public.restaurants;
create policy "restaurants 읽기" on public.restaurants for select to anon, authenticated using (true);

drop policy if exists "bipl_status 읽기" on public.bipl_status;
create policy "bipl_status 읽기" on public.bipl_status for select to anon, authenticated using (true);
-- bipl_votes 는 정책을 만들지 않아 익명 접근이 막힌다

-- 실시간 반영: 다른 사용자가 누른 결과와 수집 진행 상태를 바로 받는다
do $$
begin
  begin
    alter publication supabase_realtime add table public.bipl_status;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.regions;
  exception when duplicate_object then null;
  end;
end $$;
