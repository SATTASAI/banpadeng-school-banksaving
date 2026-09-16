# BPD School Bank — Cloudflare Worker + D1

โปรเจกต์ Cloudflare แยกต่างหากสำหรับระบบธนาคารโรงเรียน (แยกจาก `banpadeng-school-db`
ตามที่ตัดสินใจไว้ — คนละ login, คนละฐานข้อมูล, คนละโดเมน)

**Phase 1 (core banking):** ล็อกอิน/สิทธิ์ผู้ใช้, เปิดบัญชี, ฝาก-ถอน, เปิด-ปิด
Bank Session, จัดการผู้ใช้งาน

**Phase 2 (เพิ่มใหม่):** โมดูลเงินกู้ครบวงจร (ประเภทเงินกู้, ยื่นกู้, อนุมัติ/ไม่อนุมัติ,
เบิกจ่าย, ตารางผ่อนแบบดอกเบี้ยคงที่/ลดต้นลดดอก, รับชำระแบบ waterfall, ค่าปรับล่าช้า),
ปิดบัญชี (บล็อกถ้ายอดไม่เป็น 0 หรือมีเงินกู้ค้าง), ยกเลิก/แก้ไขรายการฝาก-ถอนย้อนหลัง
(สร้างรายการกลับที่ตรวจสอบยอดคงเหลือ), และส่งมอบเงินสดระหว่างผู้ใช้งาน (พร้อมการยืนยัน
รับจากผู้รับ)

**Phase 3 (เพิ่มใหม่):** เลื่อนชั้นเรียน (bulk), และจบการศึกษา/graduation-purge แบบ
มีระบบตรวจสอบก่อนดำเนินการจริง (preview) — บล็อกอัตโนมัติถ้านักเรียนคนไหนมียอดเงิน
ในบัญชีค้างอยู่หรือมีเงินกู้ค้างชำระ (ใช้ `memberHasOpenLoan()` เดียวกับที่ปิดบัญชีใช้),
ต้องพิมพ์ข้อความยืนยันให้ตรงทุกตัวอักษรก่อนดำเนินการจริง, ใช้ short-lived token
(อายุ 5 นาที ผูกกับแอดมินที่ตรวจสอบ) ป้องกันการดำเนินการผิดชุดข้อมูล, และเก็บ
snapshot ก่อนลบไว้ในตาราง `graduation_batches` เพื่อตรวจสอบย้อนหลังได้เสมอ

ยังไม่รวม: ปรับโครงสร้างหนี้ (restructuring), สำรอง/กู้คืนฐานข้อมูลแบบเต็มระบบ,
Export CSV/PDF, ออกเอกสารราชการ (DOCX/PDF) — จะทำต่อเป็นเฟสถัดไป

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

# 2) รัน schema (รันตามลำดับ ถ้าอัพเดตจากโปรเจกต์เดิมที่มีไฟล์ไม่ครบ)
npm run db:migrate:remote
npx wrangler d1 execute banpadeng-school-bank-db --remote --file=./migrations/0002_loans_closure_handover.sql
npx wrangler d1 execute banpadeng-school-bank-db --remote --file=./migrations/0003_academic_year.sql

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
npx wrangler d1 execute banpadeng-school-bank-db --local --file=./migrations/0002_loans_closure_handover.sql
npx wrangler d1 execute banpadeng-school-bank-db --local --file=./migrations/0003_academic_year.sql
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

## งานที่ยังไม่ได้ทำ (เว้นไว้เป็นเฟสถัดไป)

- ปรับโครงสร้างหนี้ (loan restructuring)
- สำรอง/กู้คืนฐานข้อมูลแบบเต็มระบบ (ตอนนี้มีแค่ snapshot อัตโนมัติก่อน purge ตอน
  จบการศึกษา เก็บใน `graduation_batches.snapshot_json`)
- Export CSV/PDF, ออกเอกสารราชการ (สัญญาเงินกู้, ใบเสร็จ ฯลฯ เป็น DOCX/PDF)
- หน้า admin แก้ไขสิทธิ์ผู้ใช้งานแบบละเอียด (ตอนนี้ต้องตั้งสิทธิ์ผ่าน API โดยตรง —
  หน้าเว็บมีแค่สร้างผู้ใช้ + ดูรายชื่อ ยังไม่มีปุ่มแก้ไขสิทธิ์ทีละอัน)
- การมอบหมายเจ้าของบัญชี Bank Session cash drawer แบบละเอียด (ตอนนี้ cash handover
  เป็นการโอนความรับผิดชอบเงินสดระหว่างผู้ใช้งานแบบพื้นฐาน ยังไม่ผูกกับยอดเงินสด
  ที่ต้องกระทบยอดตอนปิด Bank Session)

## สิทธิ์ใหม่ในเฟส 2 (ต้องเปิดให้ผู้ใช้งานที่เกี่ยวข้อง)

- `CAN_MANAGE_LOANS` — ยื่นกู้/ดูรายการเงินกู้/จัดการประเภทเงินกู้
- `CAN_APPROVE_LOAN` — อนุมัติ/ไม่อนุมัติคำขอกู้
- `CAN_DISBURSE_LOAN` — เบิกจ่ายเงินกู้เข้าบัญชี
- `CAN_RECEIVE_LOAN_PAYMENT` — รับชำระเงินกู้
- `CAN_CORRECT_TRANSACTION` — ยกเลิก/แก้ไขรายการฝาก-ถอนย้อนหลัง
- `CAN_HANDOVER_CASH` — ส่งมอบ/รับมอบเงินสด
- `CAN_CLOSE_ACCOUNT` — มีอยู่แล้วตั้งแต่ Phase 1 แต่เพิ่งเริ่มใช้งานจริงในเฟส 2
- `CAN_MANAGE_ACADEMIC_YEAR` — เลื่อนชั้น/ดำเนินการจบการศึกษา (Phase 3)

Admin มีสิทธิ์ทั้งหมดโดยอัตโนมัติ ส่วน TELLER ต้องเปิดสิทธิ์ที่ต้องการทีละคนผ่าน
`PUT /api/admin/users/:id` (ส่ง `permissions: { "CAN_MANAGE_LOANS": true, ... }`)

## ความปลอดภัย

- รหัสผ่าน: PBKDF2-SHA256, 100,000 รอบ, salt 16 ไบต์ต่อบัญชี
- Login lockout: ล็อก 15 นาทีหลังพยายามผิดครบ 8 ครั้งต่อ username (ปรับได้ที่
  `src/routes/auth.js`)
- Session token: สุ่ม 64 ตัวอักษร (UUID x2) อายุ 12 ชั่วโมง เก็บใน D1 ไม่ใช่ cookie
  (เหมือนเวอร์ชัน Apps Script เดิม)
- ไม่มี endpoint ไหนส่งรหัสผ่าน (hash หรือ plain) กลับไปที่ browser
