# Centel bridge: ผู้ช่วยในแชทจาก Hermes Agent บน Mac

ผู้ช่วยในแชทของ Centel คือ [Hermes Agent](https://github.com/NousResearch/hermes-agent) ที่รันบน Mac ที่บ้าน
สคริปต์ `centel_bridge.py` บน Mac ต่อออกไปหา centel.app เอง (long poll) จึงไม่ต้องเปิดพอร์ตหรือทำ tunnel

```
แอป ── @ผู้ช่วย ──▶ centel.app (chat_jobs) ◀── long poll ── centel_bridge.py ──▶ Hermes Agent :8642
```

## ติดตั้ง

1. ติดตั้งและตั้งค่า Hermes Agent (`hermes model` เลือกโมเดล เช่น Ollama บนเครื่อง หรือ OpenRouter ฟรี)
2. เปิด API ของ Hermes ใน `~/.hermes/.env`
   ```
   API_SERVER_ENABLED=true
   API_SERVER_KEY=ตั้งรหัสยาวๆ
   ```
   แล้วรัน `hermes gateway` ค้างไว้ (ได้ `http://127.0.0.1:8642/v1` โมเดล `hermes-agent`)
3. ในแอป Centel › บัญชี › ผู้ช่วย AI ในแชท › เชื่อม Mac แล้วคัดลอกคำสั่งไปวางใน Terminal
   ```
   curl -fsSL https://centel.app/bridge/install.sh | bash -s -- cb_TOKEN
   ```
   ตัวติดตั้งเขียน `~/.centel-bridge.env` และตั้ง launchd (`app.centel.bridge`) ให้เปิดเองตอนล็อกอิน
   log อยู่ที่ `~/.centel-bridge/bridge.log`

ตั้ง Mac ไม่ให้หลับตอนเสียบสายชาร์จ (System Settings › Battery/Energy) ไม่อย่างนั้นผู้ช่วยจะขึ้นว่าออฟไลน์
คำถามที่ค้างจะรอ 30 นาที ส่วนคำสั่ง ทำนัด / เตือน / จด ทำงานบนเซิร์ฟเวอร์เสมอแม้ Mac ปิด

## ตั้งค่า (`~/.centel-bridge.env`)

| ตัวแปร | ค่าเริ่มต้น | |
| --- | --- | --- |
| `CENTEL_TOKEN` | | จากแท็บบัญชี (สร้างใหม่ได้ ตัวเก่าจะใช้ไม่ได้) |
| `HERMES_URL` | `http://127.0.0.1:8642/v1` | ใช้ Ollama ตรงๆ ได้: `http://127.0.0.1:11434/v1` |
| `HERMES_KEY` | | `API_SERVER_KEY` ของ Hermes |
| `HERMES_MODEL` | `hermes-agent` | Ollama: เช่น `hermes3` |

ความปลอดภัย: ข้อความในแชทถูกส่งให้ Hermes บน Mac ควรปิด toolset ที่สั่ง terminal / แก้ไฟล์ของ Hermes
สำหรับงานนี้ (`hermes tools`) เพราะคนในแชทไม่ควรสั่งเครื่อง Mac ได้

หยุด: `launchctl unload ~/Library/LaunchAgents/app.centel.bridge.plist`
