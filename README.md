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
기본 경로는 메인 저장소 옆의 `<repo>.worktrees/<branch>`입니다. 브랜치 이름의 `/` 등은
`-`로 바꾸며, 목적지 폴더가 이미 있으면 다른 경로를 지정해야 합니다.

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
```

`bun run build`는 `dist/cli.js`, `dist/supervisor.js`를 만듭니다.
빌드 결과에도 Bun과 설치된 `node_modules`가 필요합니다. Python 소스나 가상환경은 사용하지 않습니다.

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
  system.ts           # 명령 실행과 경로 유틸리티
  types.ts            # 공통 타입
tests/                # Bun 통합·화면 테스트
bin/wt                # 로컬 실행 파일
```
