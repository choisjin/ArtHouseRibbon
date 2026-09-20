# 밖에서 접속하기 (arthouseribbon.com · https)

폰으로 작품을 찍어 보내려면 **https 가 필요하다.** 브라우저는 http 로 연 페이지에서 카메라·마이크를 막는다
(localhost 만 예외). 도메인 `arthouseribbon.com` 이 Cloudflare 에 있으므로 **Cloudflare Tunnel** 로 붙인다.

- 주소 나누기 (메인은 Figma Sites 로 만드는 학원 홈페이지, 리본은 옆에 붙는 사이드 페이지):

  | 주소 | 무엇 | 어떻게 |
  |---|---|---|
  | `arthouseribbon.com`, `www` | 학원 홈페이지 (Figma Sites) | Figma 가 알려 주는 DNS 레코드를 Cloudflare 에 넣는다. **Proxy 는 끄고(회색 구름) DNS only** 로 두어야 Figma 가 인증서를 발급한다 |
  | `ribbon.arthouseribbon.com` | 리본 서버 (TV·관리자·작품 찍기) | 아래 Cloudflare Tunnel |

  서로 건드리지 않는다. 메인 홈페이지에서 리본으로 가는 링크를 달아도 되고(Access 로그인 화면이 먼저 뜬다), 링크 없이 주소만 알고 써도 된다.
- 리본 주소로 mode 없이 들어오면 **무엇을 할지 고르는 메뉴**가 뜬다 (`client/src/home/index.ts`).
  맥미니 자신(localhost·랜 IP)에서 열면 예전처럼 바로 TV 화면이다.
- 공유기 포트를 열지 않는다 (맥미니가 밖으로 연결을 건다).
- 인증서는 Cloudflare 가 준다. 맥미니에서 인증서를 받거나 갱신할 일이 없다.
- 서버에 **로그인·회원가입**이 있다 (2026-09-20, `server/ribbon/auth.py`). 첫 가입자가 관리자이고, 관리 화면은 관리자만 들어간다.
  Cloudflare **Access** 로 한 겹 더 막으면(이메일 허용 목록) 로그인 화면 자체가 밖에 노출되지 않는다. 둘 다 쓰는 것을 권한다.

## 1. 맥미니에서 터널 만들기

`brew install cloudflared` 는 이미 했다면 이어서:

```bash
cloudflared tunnel login          # 브라우저가 열리면 arthouseribbon.com 을 고른다
cloudflared tunnel create ribbon  # ~/.cloudflared/<터널ID>.json 이 생긴다
cloudflared tunnel list           # 터널 ID 확인
```

## 1-1. 한 번에 하기 (스크립트)

1~2 단계(로그인·터널 만들기·설정 파일·DNS 연결)를 대신 해 준다:

```bash
cd ~/ArtHouseRibbon
bash tools/setup_tunnel.sh
```

직접 하고 싶으면 아래 2번을 보면 된다.

## 2. 설정 파일

`~/.cloudflared/config.yml` 을 만든다 (`<터널ID>` 와 `<사용자>` 는 위에서 확인한 값):

```yaml
tunnel: <터널ID>
credentials-file: /Users/<사용자>/.cloudflared/<터널ID>.json
ingress:
  - hostname: ribbon.arthouseribbon.com
    service: http://localhost:8765
  - service: http_status:404
```

도메인 연결과 시험 실행:

```bash
cloudflared tunnel route dns ribbon ribbon.arthouseribbon.com   # DNS 에 CNAME 자동 추가
cloudflared tunnel run ribbon                                   # 리본 서버를 켜 둔 채로
```

폰이나 다른 컴퓨터에서 `https://ribbon.arthouseribbon.com` 이 열리면 성공. Ctrl+C 로 끄고 자동 실행으로 바꾼다:

```bash
sudo cloudflared service install     # 맥이 켜질 때 자동 실행
```

`service install` 이 설정을 못 찾는다고 하면 `/etc/cloudflared/` 로 복사한 뒤 다시 실행한다:

```bash
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/config.yml ~/.cloudflared/<터널ID>.json /etc/cloudflared/
sudo cloudflared service install
```

## 3. Cloudflare Access 로 한 겹 더 (권장)

Cloudflare 대시보드 → Zero Trust → Access → Applications → Add an application → **Self-hosted**

- Application domain: `ribbon.arthouseribbon.com`
- Policy: Allow → **Emails** → 쓸 사람 이메일 (본인, 선생님). 로그인은 이메일로 오는 숫자 코드(OTP)나 구글 계정.
- Session duration 을 1개월쯤으로 두면 폰에서 매번 로그인하지 않는다.

무료 요금제로 50명까지 된다. 켜지 않아도 서버 로그인이 막아 주지만, 켜 두면 로그인 화면조차 밖에 보이지 않는다.

## 4. 리본 서버 쪽 설정

`server/.env` 에 한 줄 추가하고 서버를 다시 켠다:

```
RIBBON_PUBLIC_URL=https://ribbon.arthouseribbon.com
```

- 관리자 → 설정 → 📷 카메라 의 **QR 주소**가 이 도메인이 된다 (폰에서 화면 안 카메라로 바로 찍을 수 있게 된다).
- **Spotify Redirect URI 도 이 주소로 바뀐다**: `https://ribbon.arthouseribbon.com/api/music/callback`
  Spotify 대시보드 → 앱 → Settings → Redirect URIs 에 이 주소를 넣고 저장해야 로그인이 된다
  (127.0.0.1 주소는 지워도 된다). 이제 맥미니가 아닌 컴퓨터·폰에서도 Spotify 로그인을 할 수 있다.
- `start_ribbon.command` 는 `--proxy-headers` 로 띄운다 (앞단을 거쳐 와도 원래 주소를 안다). 이미 반영돼 있다.

## 4-1. TV 를 맥미니가 아닌 기기로 띄울 때 (안드로이드 폰 등)

TV 화면(`?mode=tv`)은 브라우저만 있으면 되므로 안드로이드 폰·미니 PC 로 띄워도 된다. 다만 **폰·태블릿 브라우저는
Spotify 스피커가 될 수 없다** (Web Playback SDK 가 모바일을 지원하지 않는다).

그 기기에서 **Spotify 앱**을 켜 두고, 관리자 → 음악 → **재생할 곳 = "Spotify 앱이 켜진 기기"** 로 고르면
서버가 그 앱을 조종해서 튼다 (Spotify Connect). 소리는 그 기기 → HDMI → TV 스피커로 나온다.
리본이가 말하는 동안에는 서버가 그 기기 음량을 줄였다 되돌린다.

마이크 수신기(DJI)는 **아이들이 있는 방의 기기**에 꽂혀 있어야 한다. 그 기기에서 **`/?mode=mic`** (마이크 전용 화면)를
열어 장치를 고르고 켜 두면 된다. 관리자 페이지의 설정 → 마이크에서 "이 기기를 학원 컴퓨터로 쓰기" 를 눌러도 같다.

폰 한 대로 TV 화면과 마이크를 같이 쓰지 못하는 기종이 있다 (USB 수신기를 꽂으면 소리 출력까지 USB 로 간다.
개발자 옵션 "USB 오디오 주변기기로 자동 연결 사용 중지" 를 켜면 소리는 돌아오지만 마이크 장치가 사라진다).
그럴 때는 **폰 A = TV 화면(HDMI·소리), 폰 B = 수신기 + `/?mode=mic`** 으로 나눈다.

## 5. 집 안에서 쓸 때

TV·관리자 화면은 맥미니에서 `http://localhost:8765` 로 그대로 쓴다 (localhost 는 https 가 아니어도 카메라·소리가 된다).
폰과 다른 컴퓨터는 도메인 주소로 들어간다. 도메인으로 들어가면 같은 와이파이라도 Cloudflare 를 한 번 거친다
(인터넷이 끊기면 도메인 주소는 안 된다. 그럴 때 폰은 못 쓰지만 TV·마이크는 맥미니 안에서 계속 돈다).

## 알아둘 점

- **WebSocket** 은 Cloudflare Tunnel 이 그대로 통과시킨다. 주소가 https 면 클라이언트가 알아서 `wss://` 로 붙는다.
- 사진 업로드는 Cloudflare 무료 요금제의 100MB 제한에 걸리지 않는다 (폰 사진을 긴 변 2000px 로 줄여 보낸다, `src/snap/index.ts`).
- Access 를 켜면 Spotify 에서 돌아오는 주소도 Access 를 거치는데, 이미 로그인한 브라우저라 그대로 통과한다.
- 아이 얼굴·그림이 오간다. 서버 로그인(첫 가입자가 관리자)을 먼저 만들어 두고, Access 도 걸어 두는 것이 안전하다.
- 터널이 도는지 보기: `cloudflared tunnel info ribbon`, 로그: `sudo tail -f /Library/Logs/com.cloudflare.cloudflared.err.log`
