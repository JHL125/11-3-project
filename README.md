# 비플페이 식당 지도

구획 이름(도로명 · 동 이름 · 지명)이나 "강남역 근처 국밥집"을 입력하면 구획 안 식당을 지도에 표시합니다.
누구나 식당마다 비플페이 가능/불가능을 표시할 수 있고, 가능한 집은 형광 핑크 테두리가 깜빡입니다.
설계는 [docs/design.md](docs/design.md)에 있습니다.

## 1. Supabase 준비 (한 번만)

1. 이 서비스 전용 Supabase 프로젝트를 만듭니다.
2. SQL Editor에 `supabase/schema.sql`을 통째로 붙여 넣고 실행합니다.
3. Project Settings에서 다음 세 값을 복사해 둡니다.
   - Data API → Project URL
   - API Keys → anon(publishable) 키
   - API Keys → service_role(secret) 키

`postgresql://...` 접속 문자열과 DB 비밀번호는 이 프로젝트에서 쓰지 않습니다.

## 2. 웹앱 (로컬 실행)

```bash
npm install
cp .env.example .env.local   # 값 채우기
npm run dev
```

## 3. 수집기 (내 PC에서 계속 실행)

준비할 것
- Aside CLI: Aside 설정 → Developer에서 설치한 뒤 `aside login`
- 공공데이터포털 상가(상권)정보 인증키

```bash
cd collector
npm install
cp .env.example .env         # 값 채우기
npm start
```

- 대기 요청 하나만 처리하고 끝내려면 `npm run once`
- Aside 없이 식당 조회만 시험하려면 `node --env-file=.env worker.mjs --dry 좌표.json [키워드]`. 좌표 파일 형식은 `aside-prompt.md`의 출력 형식과 같습니다.

## 4. Vercel 배포

1. 이 저장소를 Vercel에 연결합니다. 프레임워크는 Vite로 자동 인식됩니다.
2. Environment Variables에 `.env.example`의 항목을 모두 넣습니다.
   - `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
   - `GEMINI_API_KEY`, `GEMINI_MODEL`
3. 배포하면 `api/request.js`가 `/api/request` 함수로 올라갑니다.
