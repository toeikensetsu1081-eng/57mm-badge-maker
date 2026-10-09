Ver.6.4 共通印刷待ち版

変更点
- Android/iPhoneのスタッフは写真を加工して共通の待ち列に保存
- パソコンで印刷担当モードに切り替え、先頭6個を確認・PDF印刷
- 実際の印刷後に「印刷済みにする」を押して、その6個だけ待ち列から削除
- A4中心座標と水色57.00mm／黒線66.44mmを維持

パスワード不要です。RenderにPRINTER_PASSWORDの設定は必要ありません。
重要: Render Freeのローカル保存は休止・再起動で消える可能性があります。
本番でのデータ保持には外部PostgreSQLを用意し、RenderのEnvironmentに DATABASE_URL を設定してください。
DATABASE_URLが未設定でも動作テストはできますが、イベント本番の信頼性は保証できません。

GitHubにアップロードするファイル:
 staff.html, customer.html, server.js, package.json
（README_Ver6.4.txtは説明用）

Renderでデプロイ後、スタッフスマホで写真を保存し、パソコンで印刷担当モード→6個PDF→印刷→印刷済み処理を確認してください。

注意：認証を省略するため、URLを知っている第三者が印刷待ちを閲覧・印刷済みにすることも可能です。
