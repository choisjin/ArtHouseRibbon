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
- **Cloudflare Access** 로 "허락한 사람만" 들어오게 막는다. 서버 자체에는 아직 로그인이 없으니 이 문을 꼭 세운다.

## 1. 맥미니에서 터널 만들기

`brew install cloudflared` 는 이미 했다면 이어서:

```bash
cloudflared tunnel login          # 브라우저가 열리면 arthouseribbon.com 을 고른다
cloudflared tunnel create ribbon  # ~/.cloudflared/<터널ID>.json 이 생긴다
cloudflared tunnel list           # 터널 ID 확인
```

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

## 3. Cloudflare Access 로 문 잠그기 (꼭)

Cloudflare 대시보드 → Zero Trust → Access → Applications → Add an application → **Self-hosted**

- Application domain: `ribbon.arthouseribbon.com`
- Policy: Allow → **Emails** → 쓸 사람 이메일 (본인, 선생님). 로그인은 이메일로 오는 숫자 코드(OTP)나 구글 계정.
- Session duration 을 1개월쯤으로 두면 폰에서 매번 로그인하지 않는다.

무료 요금제로 50명까지 된다. 이걸 켜지 않으면 주소를 아는 누구나 관리자 페이지와 아이들 사진에 들어올 수 있다.

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

## 5. 집 안에서 쓸 때

TV·관리자 화면은 맥미니에서 `http://localhost:8765` 로 그대로 쓴다 (localhost 는 https 가 아니어도 카메라·소리가 된다).
폰과 다른 컴퓨터는 도메인 주소로 들어간다. 도메인으로 들어가면 같은 와이파이라도 Cloudflare 를 한 번 거친다
(인터넷이 끊기면 도메인 주소는 안 된다. 그럴 때 폰은 못 쓰지만 TV·마이크는 맥미니 안에서 계속 돈다).

## 알아둘 점

- **WebSocket** 은 Cloudflare Tunnel 이 그대로 통과시킨다. 주소가 https 면 클라이언트가 알아서 `wss://` 로 붙는다.
- 사진 업로드는 Cloudflare 무료 요금제의 100MB 제한에 걸리지 않는다 (폰 사진을 긴 변 2000px 로 줄여 보낸다, `src/snap/index.ts`).
- Access 를 켜면 Spotify 에서 돌아오는 주소도 Access 를 거치는데, 이미 로그인한 브라우저라 그대로 통과한다.
- 아이 얼굴·그림이 오가므로 Access 없이는 절대 열어 두지 않는다.
- 터널이 도는지 보기: `cloudflared tunnel info ribbon`, 로그: `sudo tail -f /Library/Logs/com.cloudflare.cloudflared.err.log`
