# NSD-G3000T の管理画面向け CLI

`http://192.0.2.1` のような管理画面を持つ `NSD-G3000T` 向けの CLI です。

現時点で確認できた事実:

- ログイン画面は `http://192.0.2.1/login.html` のような URL
- 認証 API は `POST /api/login`
- 初回 `GET /api/login` で `enc_pub_key` が返り、ユーザー名とパスワードは RSA 公開鍵暗号化して送る
- ログイン成功時は `pages.html` に遷移する
- 未ログインでは WiFi 設定ページ本体は `login.html` にリダイレクトされる

そのため、この CLI はまず認証と取得系を作り、ログイン後の HTML/JS を保存して WiFi 設定の保存先を特定できるようにしてあります。

## 使い方

```bash
chmod +x ./router-wifi.mjs
./router-wifi.mjs discover --username admin --password '...'
```

`discover` はログイン後に主要な HTML/JS を `.router-snapshots/<timestamp>/` に保存し、候補の `/api/...` パスと WiFi 関連らしいフィールド名を `report.json` にまとめます。

`status` は 5GHz / 2.4GHz の両方を表示します。`set` は `--band` で対象を選べて、既定は 5GHz です。

```bash
./router-wifi.mjs status --username admin --password '...'

./router-wifi.mjs set --username admin --password '...' --enabled off

./router-wifi.mjs set --username admin --password '...' --band 24g --enabled on
```

止め忘れ防止のために、指定時間帯に対して「今あるべき状態」を判定し、ずれていたら戻す `guard` もあります。

```bash
./router-wifi.mjs guard --on 07:00 --off 23:00

./router-wifi.mjs guard --band 24g --on 08:00 --off 22:00
```

`guard` は現在時刻が `--on` から `--off` の間なら ON、それ以外なら OFF とみなし、実際の状態がずれているときだけ変更します。

`guard` の結果は既定で `./router-wifi.log` に 1 行 1 JSON の形式で追記されます。`--log-file` で変更できます。

cron に登録するための `schedule` もあります。これは指定時刻ぴったりに 1 回切り替えるのではなく、一定間隔で `guard` を実行して状態を補正します。

```bash
./router-wifi.mjs schedule --on 07:00 --off 23:00

./router-wifi.mjs schedule --action install --on 07:00 --off 23:00

./router-wifi.mjs schedule --action install --on 07:00 --off 23:00 --interval 10

./router-wifi.mjs schedule --action remove
```

`install` は crontab に `router-wifi schedule` 管理ブロックを追加または更新し、`remove` はそのブロックだけを削除します。既定の監視間隔は 15 分です。

バンドごとの既定値は次です。

- 5g
- endpoint: `/api/stat/5g_enable`
- field: `5g_enabled`
- SSID field: `5g_ssid`
- 24g
- endpoint: `/api/stat/24g_enable`
- field: `24g_enabled`
- SSID field: `24g_ssid`

`set` は対象バンドの現在値を取得して、対応する SSID を引き継いだ上で、`*_enabled` だけを `"on"` / `"off"` に変えて送ります。

## パスワードの渡し方

平文引数を避けたい場合は環境変数かファイルも使えます。

```bash
export ROUTER_PASSWORD='...'
export ROUTER_USERNAME='admin'
./router-wifi.mjs discover
```

```bash
printf '%s' '...' > /tmp/router-password
export ROUTER_USERNAME='admin'
ROUTER_PASSWORD_FILE=/tmp/router-password ./router-wifi.mjs discover
```

## 制約

- 2.4GHz の API / フィールド名は 5GHz と同型の `/api/stat/24g_enable`, `24g_enabled`, `24g_ssid` を前提にしています
- もし実機が別名なら `router-wifi.mjs` の `BAND_CONFIG` を合わせてください
