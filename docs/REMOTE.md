# 밖에서 접속하기 (도메인 · https)

폰으로 작품을 찍어 보내려면 **https 가 필요하다.** 브라우저는 http 로 연 페이지에서 카메라·마이크를 막는다
(localhost 만 예외). 학원 도메인이 Cloudflare 에 있으므로 **Cloudflare Tunnel** 로 붙인다.

- 공유기 포트를 열지 않는다 (맥미니가 밖으로 연결을 건다).
- 인증서는 Cloudflare 가 준다. 맥미니에서 인증서를 받거나 갱신할 일이 없다.
- **Cloudflare Access** 로 "허락한 사람만" 들어오게 막는다. 서버 자체에는 아직 로그인이 없으니 이 문을 꼭 세운다.

## 1. 맥미니에 cloudflared 설치

```bash
brew install cloudflared
cloudflared tunnel login          # 브라우저가 열리면 학원 도메인을 고른다
cloudflared tunnel create ribbon  # 터널 만들기 (자격 증명이 ~/.cloudflared/ 에 생긴다)
```

## 2. 터널 설정

`~/.cloudflared/config.yml`:

```yaml
tunnel: ribbon
credentials-file: /Users/<사용자>/.cloudflared/<터널ID>.json
ingress:
  - hostname: ribbon.<학원도메인>
    service: http://localhost:8765
  - service: http_status:404
```

도메인 연결과 실행:

```bash
cloudflared tunnel route dns ribbon ribbon.<학원도메인>
cloudflared tunnel run ribbon            # 확인용으로 한 번 띄워 본다
sudo cloudflared service install         # 잘 되면 맥이 켜질 때 자동 실행
```

이제 `https://ribbon.<학원도메인>` 이 리본 서버다.

## 3. Cloudflare Access 로 문 잠그기 (꼭)

Cloudflare 대시보드 → Zero Trust → Access → Applications → Add an application → Self-hosted

- Application domain: `ribbon.<학원도메인>`
- Policy: Allow → Emails → 쓸 사람 이메일 (본인, 선생님). 로그인은 이메일로 오는 숫자 코드(OTP)나 구글 계정.
- Session duration 을 1개월쯤으로 두면 폰에서 매번 로그인하지 않는다.

무료 요금제로 50명까지 된다. 이걸 켜지 않으면 주소를 아는 누구나 관리자 페이지와 아이들 사진에 들어올 수 있다.

## 4. 리본 서버 쪽 설정

`server/.env` 에 도메인을 적는다:

```
RIBBON_PUBLIC_URL=https://ribbon.<학원도메인>
```

- 폰으로 여는 QR 주소가 이 도메인이 된다 (관리자 → 설정 → 카메라).
- **Spotify Redirect URI 도 이 주소로 바뀐다**: `https://ribbon.<학원도메인>/api/music/callback`.
  Spotify 대시보드의 앱 설정에 이 주소를 넣고 저장해야 로그인이 된다 (127.0.0.1 주소는 지워도 된다).
  이제 맥미니가 아닌 컴퓨터·폰에서도 로그인할 수 있다.
- `start_ribbon.command` 는 `--proxy-headers` 로 띄운다 (앞단을 거쳐 와도 원래 주소를 안다). 이미 반영돼 있다.

## 5. 집 안에서 쓸 때

TV·관리자 화면은 맥미니에서 `http://localhost:8765` 로 그대로 쓰면 된다 (localhost 는 https 가 아니어도 카메라·소리가 된다).
폰과 다른 컴퓨터는 도메인 주소로 들어간다. 도메인으로 들어가면 같은 와이파이라도 Cloudflare 를 한 번 거친다
(인터넷이 끊기면 도메인 주소는 안 된다. 그럴 때 폰은 못 쓰지만 TV·마이크는 맥미니 안에서 계속 돈다).

## 알아둘 점

- **WebSocket** 은 Cloudflare 가 그대로 통과시킨다 (Tunnel 기본 지원). 주소가 https 면 클라이언트가 알아서 `wss://` 로 붙는다.
- 사진 업로드는 기본 100MB 제한(Cloudflare 무료)에 걸리지 않는다. 폰 사진은 줄여서 보낸다 (긴 변 2000px, `src/snap/index.ts`).
- Access 를 켜면 Spotify 로그인 창에서 돌아오는 주소도 Access 를 거치는데, 이미 로그인한 브라우저라 그대로 통과한다.
- 아이 얼굴·그림이 오가므로 Access 없이는 절대 열어 두지 않는다.
