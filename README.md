# Worktree Manager

Git worktree와 개발 서버를 함께 관리하는 **TypeScript TUI**입니다.
마우스로 worktree를 선택하고, 서버 실행·종료와 TCP 포트·로그 확인을 할 수 있습니다.

## 기술 구성

- **TypeScript (strict)**: 애플리케이션, 서버 감독 프로세스, 테스트
- **Bun 1.3 이상**: 실행, 의존성 관리, 빌드, 테스트
- **OpenTUI Core**: 마우스·키보드를 지원하는 터미널 화면
- **Git / ps / lsof**: worktree 조작, 프로세스와 포트 조회
- **Commander / Biome**: CLI와 코드 검사

macOS와 Linux를 대상으로 하며, 현재 macOS에서 검증했습니다. Python과 uv는 필요하지 않습니다.

## 실행

```sh
cd /Users/nudge_181/bord/worktree-manager
bun install
bun run dev
```

다른 Git 저장소를 관리하려면:

```sh
bun run dev -C /path/to/your-project
```

다른 디렉터리에서는 프로젝트의 실행 파일을 직접 사용할 수 있습니다:

```sh
/Users/nudge_181/bord/worktree-manager/bin/wt -C /path/to/your-project
```

선택적으로 프로젝트에서 `bun link`를 실행하면 `wt` 명령을 등록할 수 있습니다.
기존에 다른 `wt` 명령을 설치했다면 먼저 `command -v wt`로 확인하세요.

**첫 커밋이 없는 저장소도 열 수 있지만, 새 worktree 생성에는 첫 커밋이 필요합니다.**
linked worktree에서 실행해도 같은 저장소의 전체 worktree를 보여줍니다.

## 개발하면서 빌드 결과 확인

| 확인할 대상 | 빌드 | 실행 |
| --- | --- | --- |
| TypeScript 소스 | 필요 없음 | `bun run dev` |
| JavaScript 빌드 결과 | `bun run build` | `bun run start` |
| 독립 실행 바이너리 | `bun run build:bin` | `./dist/wt` |

빌드하고 바로 TUI를 열려면 다음 명령을 사용하세요:

```sh
bun run preview            # JavaScript 빌드 → 실행
bun run preview:bin        # 독립 실행 바이너리 빌드 → 실행
```

코드를 수정하면서 JavaScript 산출물을 확인하려면 터미널 두 개를 사용하면 됩니다:

```sh
# 터미널 1: 소스 변경 시 dist/의 JavaScript와 소스맵 갱신
bun run build:watch

# 터미널 2: 현재 빌드 결과 실행
bun run start
```

빌드가 갱신되면 실행 중인 TUI에서 `q`를 누르고 `bun run start`로 다시 여세요.
소스 변경 때 TUI 자체를 재시작하려면 `bun run dev:watch`를 사용합니다.
watch 프로세스는 `Ctrl+C`로 종료합니다. 앱 재시작 중에도 관리 중인 개발 서버는 유지됩니다.

`bun run build:bin`은 **현재 운영체제와 CPU용** `dist/wt` 한 파일을 생성합니다.
Bun 런타임, 앱 코드, OpenTUI 네이티브 라이브러리를 포함하므로 실행할 때 Bun이나 `node_modules`가
필요하지 않습니다. Git·`ps`·`lsof`와 실제 개발 서버가 사용하는 도구는 실행 환경에 있어야 합니다.
바이너리는 다른 폴더로 복사해도 사용할 수 있습니다:

```sh
./dist/wt --version
./dist/wt -C /path/to/your-project
```

바이너리에는 서버 감독 프로세스도 포함됩니다. 실행 중인 이전 바이너리를 유지한 채 새 빌드를
교체할 수 있도록 임시 파일에서 빌드한 뒤 성공했을 때 `dist/wt`를 교체합니다.
`build:watch`는 JavaScript 산출물만 갱신하므로 바이너리를 확인할 때는 `build:bin`을 다시 실행하세요.

## 화면 사용법

1. 목록에서 worktree를 클릭합니다. `*`는 로컬 변경 사항을 뜻합니다.
2. **Run**에서 실행 명령을 입력합니다. 예: `pnpm dev --port 3001`.
3. 포트 행을 선택하고 **Browser**로 엽니다. **Copy URL**도 사용할 수 있습니다.
4. **SERVER OUTPUT**에서 서버 출력을 읽습니다.
5. **Stop**으로 앱에서 실행한 서버와 하위 프로세스를 종료합니다.

행 선택, 버튼, 스크롤을 마우스로 조작할 수 있습니다. `Tab` / `Shift+Tab`으로 초점을 옮기고
`Enter`로 버튼을 실행합니다. 100열 × 38행 이상을 권장하며, 좁은 터미널에서는 세로 배치로
바뀝니다. 보이지 않는 영역은 마우스 휠이나 스크롤바로 이동하세요.

| 키 | 동작 |
| --- | --- |
| `↑` / `↓` | worktree 또는 포트 선택 |
| `n` | worktree 생성 |
| `r` / `s` | 서버 실행 / 종료 |
| `o` | 선택한 포트를 브라우저로 열기 |
| `e` / `t` | 에디터 / 새 터미널 열기 |
| `d` | worktree 삭제 확인창 |
| `F5` | 새로고침 (자동 갱신은 2초 간격) |
| `Esc` | 입력창 / 확인창 닫기 |
| `q` | 앱 종료 |

`+ New worktree`는 새 브랜치 생성과 기존 브랜치 checkout을 모두 지원합니다.
**Base branch / ref ▾** 입력란을 클릭하거나 `↓` 또는 `Enter`를 누르면 기준 브랜치 드롭다운이 열립니다.
선택하면 목록이 접히며, 다시 열면 전체 옵션을 볼 수 있습니다. `Esc`는 목록을 먼저 닫고, 한 번 더 누르면 생성 창을 닫습니다.
입력란에 이름 일부를 입력하면 로컬·원격 브랜치를 검색하며, `↓`로 목록에 초점을 옮긴 뒤
`↑` / `↓`와 `Enter`로 선택할 수도 있습니다. 기본값 `HEAD`는 앱을 실행한 worktree의 현재 커밋입니다.
태그나 커밋을 직접 입력하는 것도 가능합니다. 원격 브랜치는 이미 fetch한 목록을 사용하므로
최신 원격 목록이 필요하면 먼저 `git fetch`를 실행하세요.
**Use an existing branch**를 켜면 기준 브랜치 선택은 비활성화됩니다.
새 브랜치는 선택한 기준 커밋에서 생성하며, 기준 브랜치를 upstream으로 자동 연결하지 않습니다.
처음 원격에 올릴 때는 `git push -u origin <브랜치명>`으로 같은 이름의 원격 브랜치와 연결하세요.
기존 브랜치를 checkout하는 경우에는 기존 upstream 설정을 유지합니다.

기본 경로는 `~/.worktree-managers/<프로젝트명>/<브랜치명>`입니다.
프로젝트명은 원본 저장소 폴더 이름을 사용하고, 브랜치 이름의 `/`는 `--`로 바꿉니다.
예를 들어 `worktree-manager` 프로젝트의 `feature/login` 브랜치는
`~/.worktree-managers/worktree-manager/feature--login`에 생성됩니다.
같은 이름의 다른 프로젝트나 변환 후 폴더명이 겹치면 짧은 식별자를 붙여 구분합니다.
프로젝트 폴더의 숨김 파일 `.repository`는 저장소 식별용이므로 유지해 주세요.
원본 저장소와 이미 생성한 worktree는 이동하지 않으며, 연결된 worktree에서 생성해도
같은 프로젝트 폴더에 모입니다. 앱에는 실제 브랜치명과 경로가 표시됩니다.
**Directory** 또는 CLI의 `--path`를 지정하면 해당 경로를 사용하며, 이미 존재하면 오류를 표시합니다.

기본 에디터는 `code`입니다. GUI 에디터 명령을 `WT_EDITOR`로 바꿀 수 있습니다:

```sh
WT_EDITOR=cursor bun run dev
WT_EDITOR='code --new-window' bun run dev
```

새 터미널은 macOS의 Terminal.app 또는 Linux의 `x-terminal-emulator`로 엽니다.
브라우저는 `open` / `xdg-open`, 클립보드는 터미널의 OSC 52 지원을 사용합니다.

## 서버와 포트

- worktree마다 하나의 실행 명령을 관리합니다. 명령이 여러 서버를 시작하면 여러 포트가 표시됩니다.
- **앱을 종료해도 서버는 계속 실행됩니다.** 재실행하거나 `wt stop`으로 종료할 수 있습니다.
- 명령은 해당 worktree에서 `/bin/sh -c`로 실행됩니다. 실행 환경의 변수를 상속하며,
  대화형 셸의 alias·함수는 로드하지 않습니다. 패키지 설치는 자동으로 수행하지 않습니다.
- 서버 명령은 포그라운드로 유지되어야 합니다. `nohup`이나 daemon 옵션으로 분리하지 마세요.
  여러 프로세스를 시작한다면 `server-a & server-b & wait`처럼 셸이 기다리도록 작성하세요.
- 마지막 명령을 프로젝트 기본값으로 저장합니다. 실행 이력이 있는 worktree는 자신의 최근 명령을
  우선 표시합니다. 이력이 없으면 `package.json`의 `dev` 스크립트도 제안합니다.
- 선택적 **PORT**는 사용 여부를 확인하고 `PORT` 환경 변수를 설정합니다. 프레임워크가 이를 무시하면
  명령에 `--port` 등 자체 옵션을 직접 넣어야 합니다. 포트를 예약하는 기능은 아닙니다.
- **Managed**는 앱에서 실행한 서버의 하위 프로세스입니다. **External**은 프로세스의 작업 경로로
  worktree에 연결한 외부 서버이며 조회만 합니다.
- Browser는 HTTP URL을 엽니다. DB, HTTPS 전용 서비스 등은 해당 프로토콜용 클라이언트를 사용하세요.
- 권한상 조회할 수 없는 프로세스, Docker 내부, 원격 서버의 포트는 표시되지 않을 수 있습니다.

메인 worktree, 잠긴 worktree, 변경 사항이 있는 worktree, 실행 중인 서버가 있는 worktree는
삭제하지 않습니다. 강제 삭제는 제공하지 않으며 **worktree를 삭제해도 Git 브랜치는 유지**합니다.

서버 감독 프로세스를 별도로 실행하고 프로세스 시작 시각을 기록합니다. 종료 요청은 실행별 토큰이
있는 제어 파일로 전달하며, 감독 프로세스가 자신이 만든 서버 프로세스 그룹만 종료합니다.

## CLI

아래 예시는 `wt` 명령을 등록한 경우입니다. 등록하지 않았다면 `wt` 대신 `bun run dev`를 사용하세요.

```sh
wt list
wt list --json
wt add feature/login
wt add feature/login --path /path/to/worktrees/login --base main
wt add feature/api --base origin/develop
wt add existing-branch --existing
wt run -c 'pnpm dev --port 3001'
wt run feature/login -c 'npm run dev' --port 3001
wt logs feature/login
wt stop feature/login
wt remove feature/login --yes
wt -C /path/to/repo list
```

대상은 브랜치 이름, 폴더 이름, 전체 경로로 지정합니다. 이름이 겹치면 전체 경로를 사용하세요.
`run`, `stop`, `logs`의 대상을 생략하면 현재 worktree를 사용합니다.

## 상태 저장과 이전 버전

공통 Git 디렉터리의 `worktree-manager/`에 상태를 저장합니다.
일반 저장소에서는 `.git/worktree-manager/`이며 모든 linked worktree가 공유합니다.

```text
worktree-manager/
  state.json                  # 기본 명령과 worktree별 최근 실행
  operations.lock/            # 변경 중에만 존재하는 프로세스 간 잠금
  runs/<run-id>/
    spec.json                 # 명령, 작업 경로, 실행 토큰
    ready.json                # 감독 프로세스 식별 정보
    server.log                # 표준 출력과 오류
    stop                      # 종료 요청 시 생성
    result.json               # 종료 코드와 종료 시각
```

상태 갱신은 프로세스 간 잠금과 원자적 파일 교체를 사용합니다. TUI는 최근 로그 약 32KB를 읽습니다.
이전 로그는 자동 정리하지 않습니다. 서버를 종료한 뒤 사용하지 않는 실행 폴더를 지울 수 있습니다.

이전 Python 버전의 저장 명령·로그·실행 기록도 읽을 수 있습니다. 이전 앱을 닫고 새 버전을 실행하세요.
이미 실행 중인 이전 감독 프로세스는 시작 시각과 명령 경로를 확인한 뒤 종료할 수 있습니다.
Python 버전과 TypeScript 버전은 잠금 방식이 다르므로 동시에 같은 상태를 변경하지 마세요.

## 개발 및 검증

```sh
bun install --frozen-lockfile
bun run typecheck
bun run check
bun test
bun run build
bun run start
bun run build:bin
bun run verify:build
```

`bun run build`는 `dist/cli.js`, `dist/supervisor.js`와 각각의 `.map` 소스맵을 만듭니다.
이 JavaScript 산출물에는 Bun과 설치된 `node_modules`가 필요합니다.
`bun run build:bin`은 독립 실행 파일 `dist/wt`를 만듭니다.

`bun run verify:build`는 두 형식을 새로 빌드한 뒤 임시 Git 저장소와 독립 테스트 서버를 사용해
실행·포트 감지·로그·종료를 검증합니다. 바이너리는 소스나 `node_modules`가 없는 별도 폴더로 복사하고,
PATH에서 Bun과 Node를 제외하여 확인합니다.

테스트는 임시 Git 저장소와 실제 Bun HTTP 서버를 사용합니다. 생성·삭제 보호, 외부 서버 조회,
포트 충돌, 재연결, PID 재사용 보호, 다중 프로세스 종료, 동시 실행 잠금, 이전 상태 읽기를 검증합니다.
OpenTUI 테스트 렌더러로 마우스 생성·삭제·실행·종료와 작은 화면의 키보드 입력도 검증합니다.

```text
src/
  app.ts              # TUI와 입력 처리
  cli.ts              # wt 진입점과 CLI
  git.ts              # Git worktree 조작
  manager.ts          # 서버 관리와 worktree/포트 연결
  process-info.ts     # ps, lsof와 프로세스 식별
  store.ts            # 상태 저장과 잠금
  supervisor.ts       # 분리된 서버 실행·종료
  standalone.ts       # 단일 바이너리 진입점과 감독 프로세스 실행
  system.ts           # 명령 실행과 경로 유틸리티
  types.ts            # 공통 타입
tests/                # Bun 통합·화면 테스트
scripts/              # 바이너리 빌드 및 산출물 검증
bin/wt                # 로컬 실행 파일
```
