# BPD School Bank — Cloudflare Worker + D1 (Phase 1: Core Banking)

โปรเจกต์ Cloudflare แยกต่างหากสำหรับระบบธนาคารโรงเรียน (แยกจาก `banpadeng-school-db`
ตามที่ตัดสินใจไว้ — คนละ login, คนละฐานข้อมูล, คนละโดเมน) เวอร์ชันนี้คือ **Phase 1**
ครอบคลุมเฉพาะ core banking: ล็อกอิน/สิทธิ์ผู้ใช้, เปิดบัญชี, ฝาก-ถอน, เปิด-ปิด
Bank Session, และจัดการผู้ใช้งานเบื้องต้น

ยังไม่รวม: โมดูลเงินกู้, เลื่อนชั้น/จบการศึกษาประจำปี, สำรอง/กู้คืนฐานข้อมูล,
ออกเอกสาร/Export — จะทำต่อเป็นเฟสถัดไปตามที่คุยกันไว้ (core ให้เสร็จ ใช้งานได้จริง
ก่อน ค่อยต่อโมดูลอื่น)

## สิ่งที่ต่างจากเวอร์ชัน Apps Script เดิม (ตั้งใจให้ต่างและดีขึ้น)

- **เก็บเงินเป็นหน่วยสตางค์ (INTEGER)** แทน float บาท ป้องกันปัญหาเศษทศนิยมสะสมที่
  Apps Script ต้องใช้ `roundMoney_()` ช่วยแก้
- **รหัสผ่าน hash ด้วย PBKDF2-SHA256** (ไม่ใช่ plain text) ตั้งแต่ต้น และไม่มี endpoint
  ไหนส่งรหัสผ่านกลับไปที่ browser เลย
- **ไม่มี global lock ตัวเดียวครอบทุกธุรกรรม** — ใช้ atomic conditional UPDATE ต่อบัญชี
  แทน (เช่น ถอนเงินเช็ค `balance >= amount` ในเงื่อนไข WHERE ของคำสั่ง UPDATE เดียว)
  ทำให้ฝาก-ถอนหลายจุดพร้อมกันได้จริงโดยยอดเงินไม่มีทางติดลบ
- **Idempotency key (`requestId`)** ในการฝาก/ถอน กันการกดซ้ำ/เน็ตหลุดแล้ว retry ทำให้
  เกิดรายการซ้ำ
- **session เก็บใน D1 พร้อม index บน `expires_at`** และมีการล้าง session หมดอายุ
  แบบสุ่ม (~5% ของการล็อกอิน) แทนการเก็บใน Script Properties ที่มีโควตาจำกัด

## Setup ครั้งแรก

```bash
npm install

# 1) สร้าง D1 database
npx wrangler d1 create banpadeng-school-bank-db
# คัดลอก database_id ที่ได้ไปใส่ใน wrangler.jsonc (REPLACE_WITH_REAL_DATABASE_ID)

# 2) รัน schema
npm run db:migrate:remote

# 3) deploy
npm run deploy

# 4) สร้างบัญชี Admin คนแรก (ทำครั้งเดียว — endpoint นี้จะปฏิเสธถ้ามีผู้ใช้อยู่แล้ว)
curl -X POST https://<your-worker>.workers.dev/api/setup \
  -H "content-type: application/json" \
  -d '{"username":"admin","password":"เปลี่ยนรหัสนี้ทันที","displayName":"ผู้ดูแลระบบ"}'
```

จากนั้นเข้า `https://<your-worker>.workers.dev/login.html` เพื่อล็อกอิน

ถ้าจะผูกโดเมนของตัวเอง (เช่น `bank.บ้านป่าเด็ง...`) ตั้งค่า custom domain ได้จากหน้า
Cloudflare Dashboard > Workers > โปรเจกต์นี้ > Settings > Domains & Routes

## ทดสอบ local ก่อน deploy จริง

```bash
npm run db:migrate:local
npm run dev
```

จะรันที่ `http://localhost:8787` ใช้ D1 แบบ local (ไม่กระทบข้อมูลจริง) เหมาะสำหรับ
ทดสอบก่อน deploy ตามแนวทางที่เคยทำกับ Index.html เวอร์ชัน Apps Script (ทดสอบบนสำเนา
ก่อนขึ้นจริงเสมอ)

## โครงสร้างโปรเจกต์

```
src/
  index.js            router หลัก
  auth.js             hash รหัสผ่าน, session, permission check
  money.js            แปลงบาท <-> สตางค์
  permissions.js      รายการสิทธิ์ + ค่าเริ่มต้นตาม role
  routes/
    auth.js           setup / login / logout / bootstrap / เปลี่ยนรหัสผ่าน
    admin.js          จัดการผู้ใช้งาน + สิทธิ์
    accounts.js       ค้นหา/เปิดบัญชี
    transactions.js   ฝาก / ถอน / ดูประวัติ
    banksession.js    เปิด-ปิด Bank Session, จุดทำรายการ
migrations/
  0001_init.sql       D1 schema
public/
  index.html          redirect ตาม token ที่มีใน localStorage
  login.html
  app.html            หน้าเว็บหลัก (ฝาก-ถอน, เปิดบัญชี, จัดการผู้ใช้งาน)
```

## งานที่ยังไม่ได้ทำในเฟสนี้ (ตั้งใจเว้นไว้)

- ปิดบัญชี / โอนย้าย / แก้ไขรายการย้อนหลัง (correction) — ของเดิมมีระบบ reversal ที่
  ค่อนข้างซับซ้อน จะพอร์ตเป็นเฟสถัดไป
- Cash handover ระหว่างผู้ใช้งาน
- โมดูลเงินกู้ทั้งหมด (ตารางผ่อน, ดอกเบี้ย, ปรับโครงสร้างหนี้) — ตรรกะการคำนวณใน
  Apps Script เดิมค่อนข้างดีอยู่แล้ว พอร์ตตรงๆ ได้ไม่ต้องออกแบบใหม่มาก
- โมดูลเลื่อนชั้น/จบการศึกษา + purge ข้อมูล — ต้องคง logic การบล็อกกรณีมีเงินกู้ค้าง
  ที่เพิ่งแก้ไว้ในเวอร์ชัน Apps Script ด้วย
- Export CSV/PDF, ออกเอกสารราชการ (DOCX/PDF)
- หน้า admin แก้ไขผู้ใช้/สิทธิ์แบบละเอียด (ตอนนี้มีแค่สร้างผู้ใช้ + ดูรายชื่อ)

## ความปลอดภัย

- รหัสผ่าน: PBKDF2-SHA256, 100,000 รอบ, salt 16 ไบต์ต่อบัญชี
- Login lockout: ล็อก 15 นาทีหลังพยายามผิดครบ 8 ครั้งต่อ username (ปรับได้ที่
  `src/routes/auth.js`)
- Session token: สุ่ม 64 ตัวอักษร (UUID x2) อายุ 12 ชั่วโมง เก็บใน D1 ไม่ใช่ cookie
  (เหมือนเวอร์ชัน Apps Script เดิม)
- ไม่มี endpoint ไหนส่งรหัสผ่าน (hash หรือ plain) กลับไปที่ browser
