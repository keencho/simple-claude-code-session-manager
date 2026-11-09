# ConPTY (sideloaded)

Windows Terminal의 ConPTY. 설치 폴더에 실행 파일과 같이 들어가면 `portable-pty`가
Windows 내장 ConPTY 대신 이쪽을 쓴다 (`conpty.dll`을 먼저 찾는다).

내장 ConPTY는 claude 출력을 자기 화면 기준으로 다시 그려 내보내서 화면이 어긋날 수 있고,
합성 이모지(👍🏻, 🇰🇷, 👨‍👩‍👧) 폭을 4~8칸으로 잘못 센다. 이 버전은 출력을 그대로 넘긴다.
Windows Terminal, VS Code, Zed도 같은 이유로 이 파일을 같이 배포한다.

- 출처: NuGet `Microsoft.Windows.Console.ConPTY` 1.25.260930003 (x64)
  - `runtimes/win-x64/native/conpty.dll`
  - `build/native/runtimes/x64/OpenConsole.exe`
- 서명: Microsoft Corporation (Authenticode 유효)
- 라이선스: MIT (`LICENSE`, microsoft/terminal)
- SHA-256
  - `conpty.dll` feeef341d891643c62d30b6b07800bc70f0bc148f44cb8c3bee84aa557ae805a
  - `OpenConsole.exe` 3d66b23d0a71bb8eed2b77edc8b9df9bf54ce6c8fb74c863a30e760997f80586

갱신: 새 버전 nupkg를 받아 위 두 파일을 교체하고 이 문서의 버전·해시를 고친다.
