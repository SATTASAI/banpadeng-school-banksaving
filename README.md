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

**Phase 4 (เพิ่มใหม่):** สำรอง/กู้คืนฐานข้อมูลทั้งระบบ (Admin เท่านั้น — export เป็น
ไฟล์ JSON, restore ต้องพิมพ์ข้อความยืนยันให้ตรงทุกตัวอักษรเพราะเป็นการลบข้อมูล
ปัจจุบันทั้งหมดแล้วแทนที่), export รายงานเป็น CSV (รายการฝาก-ถอนทั้งหมด, รายชื่อ
บัญชีทั้งหมด — เปิดด้วย Excel/Sheets ได้ตรงๆ), และใบเสร็จพิมพ์ได้ต่อรายการฝาก-ถอน
(หน้า `receipt.html` ใช้ปุ่ม "พิมพ์/บันทึกเป็น PDF" ของเบราว์เซอร์)

**Phase 5 (เพิ่มใหม่):** ดอกเบี้ยเงินฝาก/เงินปันผล (คำนวณจากยอดคงเหลือปัจจุบัน ณ
เวลาที่ดำเนินการ คูณอัตราที่กำหนด ไม่ใช่ยอดเฉลี่ยรายวัน — ตรงกับวิธีที่ธนาคาร
โรงเรียนทำจริงปีละ 1-2 ครั้ง) ใช้ pattern ตรวจสอบตัวอย่างก่อนแบบเดียวกับการจบ
การศึกษา (preview token อายุ 5 นาที ผูกกับแอดมินที่ตรวจสอบ คำนวณใหม่จากยอด
ปัจจุบันตอนกดยืนยันจริงและข้ามบัญชีที่ไม่มีสิทธิ์แล้ว), หน้ารายงานสรุปผล
(ยอดรวมแยกตามประเภทบัญชี, ยอดฝาก-ถอนตามช่วงเวลา, สรุปตามชั้น/ห้อง, ยอดเงินกู้
ค้างชำระ), และประวัติธุรกรรมแบบละเอียด (กรองตามวันที่/ประเภท/ผู้ทำรายการ/
จุดทำรายการ/ค้นหาชื่อหรือเลขบัญชี พร้อม pagination)

**Phase 6 (เพิ่มใหม่ แล้วขยายเพิ่มอีกรอบ):** นำเข้าข้อมูลจากไฟล์สำรองของระบบเดิม
(Apps Script "BPD School Bank") — อัปโหลดไฟล์ .xlsx ที่ได้จากฟีเจอร์สำรองข้อมูลของ
ระบบเดิมโดยตรง (อ่านทุกชีตที่มีในไฟล์ด้วย SheetJS ฝั่งเบราว์เซอร์ ไม่ต้องแปลงไฟล์เอง)
รองรับทั้งไฟล์สำรอง **แบบย่อ** (มีแค่ `BANK_MEMBERS` / `ACCOUNTS` / `TRANSACTIONS`)
และไฟล์สำรอง **แบบเต็มระบบ** (มีเพิ่ม `USERS` / `LOCATIONS` / `SETTINGS` /
`BANK_SESSIONS` / `CASH_HANDOVERS` / `USER_PERMISSIONS` / `LOAN_PRODUCTS` ด้วย) —
อัปโหลดไฟล์เดียวแล้วใช้งานต่อได้ทันทีโดยไม่ต้องตั้งค่าอะไรซ้ำ:

- จับคู่เจ้าของบัญชีผ่าน `ACCOUNTS.OWNER_ID` -> `BANK_MEMBERS.MEMBER_ID`, แปลงประเภท
  ธุรกรรมเดิม (`DEPOSIT`/`WITHDRAW`/`OPENING_DEPOSIT`/`INTEREST`/`DIVIDEND`/
  `CLOSE_WITHDRAW`/`REVERSAL`) เป็นประเภทของระบบใหม่, **จำลองเดินบัญชีตามลำดับเวลา
  ใหม่ทั้งหมด** เพื่อคำนวณยอดก่อน/หลังของทุกรายการให้สอดคล้องกัน แล้วถ้ายอดที่
  จำลองได้ไม่ตรงกับยอดคงเหลือปัจจุบันที่บันทึกไว้ในระบบเดิม จะเติมรายการ
  "ปรับยอดจากการนำเข้าข้อมูลระบบเดิม" ให้ยอดตรงกันเสมอ
- **ทุกแถวที่นำเข้าใช้ id เดิมจากระบบเก่าเป็น id ในระบบใหม่โดยตรง** (เช่น
  `MEMBER_ID`, `ACCOUNT_ID`, `TX_ID`, `USER_ID`, `SESSION_ID`) ทำให้การนำเข้า
  เป็น idempotent โดยธรรมชาติผ่าน `INSERT OR IGNORE` — อัปโหลดไฟล์เดิมซ้ำกี่ครั้ง
  ก็ปลอดภัย ไม่มีข้อมูลซ้ำซ้อน
- รหัสผ่านผู้ใช้งานเดิม (เก็บเป็น plain text ในระบบเก่า) จะถูก hash ใหม่ด้วย
  PBKDF2-SHA256 ตอนนำเข้าทันที (ผู้ใช้งานยังคงใช้รหัสผ่านเดิมล็อกอินได้ แต่ระบบใหม่
  ไม่เก็บรหัสผ่านแบบเปิดเผยอีกต่อไป) — ชื่อผู้ใช้งานที่ซ้ำกับบัญชีที่มีอยู่แล้วในระบบ
  ใหม่ (unique บน `username`) จะถูกข้ามและ**ผูกรายการอ้างอิงทั้งหมด (ธุรกรรม,
  bank session, cash handover) เข้ากับบัญชีเดิมที่มีอยู่แล้วโดยอัตโนมัติ** ไม่ทับ
  รหัสผ่านหรือสร้างบัญชีซ้ำ
- สิทธิ์การใช้งาน (`USER_PERMISSIONS`) แปลงชื่อสิทธิ์บางส่วนที่ใกล้เคียงกันในระบบเก่า
  มาเป็นชื่อสิทธิ์ของระบบใหม่ (เช่น `CAN_VIEW_LOANS`/`CAN_CREATE_LOAN_APPLICATION`
  -> `CAN_MANAGE_LOANS`) ส่วนสิทธิ์ที่ไม่มีของเทียบเท่าในระบบใหม่จะไม่ถูกนำเข้า
  (แอดมินตั้งค่าเพิ่มเองภายหลังได้)
- ใช้ pattern ตรวจสอบตัวอย่างก่อนแบบเดียวกับโมดูลอื่น แต่เก็บเฉพาะ SHA-256 hash
  ของข้อมูลที่ตรวจสอบไว้ในฐานข้อมูล (ไม่เก็บข้อมูลทั้งก้อนซึ่งอาจมีขนาดหลาย MB)
  แล้วให้เบราว์เซอร์ส่งข้อมูลชุดเดิมกลับมาตอนยืนยันจริง — ถ้าไฟล์ถูกแก้ไขระหว่างทาง
  จะปฏิเสธการนำเข้าทันที (จำกัดเฉพาะ role ADMIN)
- ทดสอบแล้วกับไฟล์สำรองจริงของโรงเรียนทั้งสองแบบ (แบบย่อ ~1200 บัญชี/9600 รายการ
  และแบบเต็มระบบที่มีผู้ใช้งาน/สิทธิ์/Bank Session/Cash Handover ด้วย) ยืนยันด้วย
  สคริปต์จำลองว่ายอดคงเหลือทุกบัญชีตรงกับประวัติธุรกรรม 100% และนำเข้าไฟล์เดิมซ้ำ
  ได้โดยไม่มีข้อมูลซ้ำ

ยังไม่รวม: ปรับโครงสร้างหนี้ (loan restructuring), ออกเอกสารราชการแบบเต็ม
(สัญญาเงินกู้ DOCX ที่ต้องกรอกแบบฟอร์มราชการ) — จะทำต่อเป็นเฟสถัดไป

**สำคัญ (แก้บั๊ก Phase 1):** `migrations/0005_fix_transactions_nullable_bank_session.sql`
แก้ปัญหาที่พบระหว่างพัฒนา Phase 5 — ตาราง `transactions` เดิมกำหนด
`bank_session_id NOT NULL` แต่โค้ดเปิดบัญชี (`accounts.js`) ที่มียอดเปิดบัญชี
มากกว่า 0 บาท insert รายการ `OPENING_DEPOSIT` โดยส่ง `bank_session_id = NULL`
มาตั้งแต่ Phase 1 ซึ่งจะถูกฐานข้อมูลปฏิเสธจริง (เปิดบัญชีพร้อมฝากเงินตั้งต้น
จะ error) — ถ้าฐานข้อมูลจริงรันมาตั้งแต่ Phase 1 **ต้องรัน migration นี้ก่อน**
ตัวอื่นในเฟส 5 (ดอกเบี้ย/เงินปันผลก็ insert แบบไม่ผูก Bank Session เหมือนกัน)

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
npx wrangler d1 execute banpadeng-school-bank-db --remote --file=./migrations/0004_backup_log.sql
npx wrangler d1 execute banpadeng-school-bank-db --remote --file=./migrations/0005_fix_transactions_nullable_bank_session.sql
npx wrangler d1 execute banpadeng-school-bank-db --remote --file=./migrations/0006_interest_reports.sql
npx wrangler d1 execute banpadeng-school-bank-db --remote --file=./migrations/0007_legacy_import.sql

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
npx wrangler d1 execute banpadeng-school-bank-db --local --file=./migrations/0004_backup_log.sql
npx wrangler d1 execute banpadeng-school-bank-db --local --file=./migrations/0005_fix_transactions_nullable_bank_session.sql
npx wrangler d1 execute banpadeng-school-bank-db --local --file=./migrations/0006_interest_reports.sql
npx wrangler d1 execute banpadeng-school-bank-db --local --file=./migrations/0007_legacy_import.sql
npm run dev
```

จะรันที่ `http://localhost:8787` ใช้ D1 แบบ local (ไม่กระทบข้อมูลจริง) เหมาะสำหรับ
ทดสอบก่อน deploy ตามแนวทางที่เคยทำกับ Index.html เวอร์ชัน Apps Script (ทดสอบบนสำเนา
ก่อนขึ้นจริงเสมอ)

## นำเข้าข้อมูลจากระบบเดิม (Apps Script) — Phase 6

ใช้ครั้งเดียวตอนย้ายจากระบบเดิมมาระบบใหม่นี้ (ทำได้ซ้ำอย่างปลอดภัยถ้าจำเป็น) —
**อัปโหลดไฟล์เดียว แล้วใช้งานต่อได้ทันที** ไม่ว่าไฟล์สำรองจะเป็นแบบย่อหรือแบบเต็มระบบ:

1. เข้าสู่ระบบด้วยบัญชี ADMIN แล้วไปที่แท็บ "สำรอง/ออกรายงาน"
2. ในหัวข้อ "นำเข้าข้อมูลจากระบบเดิม (Apps Script)" เลือกไฟล์ .xlsx ที่ได้จากฟีเจอร์
   สำรองข้อมูลของระบบเดิม — ระบบจะอ่านทุกชีตที่มีอยู่ในไฟล์โดยอัตโนมัติ (ต้องมีอย่างน้อย
   `BANK_MEMBERS`, `ACCOUNTS`, `TRANSACTIONS`; ส่วน `USERS`, `LOCATIONS`, `SETTINGS`,
   `BANK_SESSIONS`, `CASH_HANDOVERS`, `USER_PERMISSIONS`, `LOAN_PRODUCTS` มีหรือไม่มีก็ได้
   — ไม่ต้องแก้ไขไฟล์เอง)
3. กด "คำนวณตัวอย่าง" — ระบบจะอ่านไฟล์ในเบราว์เซอร์ (ไม่ต้องอัปโหลดไฟล์ดิบขึ้นเซิร์ฟเวอร์
   เป็นไฟล์แยก) แล้วส่งข้อมูลไปคำนวณตัวอย่างผล พร้อมแสดงจำนวนของทุกประเภทข้อมูลที่จะ
   นำเข้า (สมาชิก/บัญชี/ธุรกรรม/ผู้ใช้งาน/จุดทำรายการ/ค่าตั้งค่า/Bank Session/Cash
   Handover/ประเภทเงินกู้), รายการที่ถูกข้าม (พร้อมเหตุผล), และจำนวนรายการที่ต้อง
   "ปรับยอด" เพื่อให้ตรงกับยอดคงเหลือที่บันทึกไว้ในระบบเดิม
4. ตรวจสอบตัวเลขให้เรียบร้อยก่อน แล้วกด "ยืนยันนำเข้าข้อมูลนี้" — ขั้นตอนนี้เซิร์ฟเวอร์
   จะคำนวณซ้ำจากข้อมูลชุดเดียวกับตอนตรวจสอบตัวอย่างเท่านั้น (ตรวจสอบด้วย hash) ถ้าไฟล์
   หรือข้อมูลเปลี่ยนไประหว่างทางจะถูกปฏิเสธและต้องกดคำนวณตัวอย่างใหม่
5. รายการที่มีอยู่แล้วในระบบใหม่ (ชื่อผู้ใช้งานซ้ำ, เลขบัญชี `account_no` ซ้ำ, หรือ id
   เดิมจากระบบเก่าที่เคยนำเข้าไปแล้ว) จะถูกข้ามอัตโนมัติเสมอ — กดนำเข้าไฟล์เดิมซ้ำอีก
   ครั้งจึงไม่ทำให้เกิดข้อมูลซ้ำซ้อน
6. หลังนำเข้าเสร็จ ผู้ใช้งานที่นำเข้ามาจากไฟล์สามารถล็อกอินด้วย**รหัสผ่านเดิมที่เคยใช้ใน
   ระบบเก่าได้ทันที** (ระบบ hash รหัสผ่านให้ใหม่ตอนนำเข้า ไม่ได้เก็บ plain text ต่อ)

**API ที่เกี่ยวข้อง** (ต้องเป็น ADMIN, ผ่าน `requireAdmin`):
- `POST /api/backup/import-legacy/preview` — รับ `{ members, accounts, transactions,
  users, locations, settings, bankSessions, cashHandovers, userPermissions,
  loanProducts }` (แถวข้อมูลดิบจากแต่ละชีต ชีตที่ไม่มีในไฟล์ส่งเป็น `[]`) คืน
  `{ token, summary, expiresAt }` (token อายุ 15 นาที)
- `POST /api/backup/import-legacy/commit` — รับ `{ token, ...ข้อมูลชุดเดียวกับตอน
  preview }` ตรวจสอบ hash แล้วดำเนินการนำเข้าจริง คืนสรุปผลที่นำเข้าได้จริงต่อตาราง
  (`importedCounts`) หลังข้ามรายการที่ซ้ำ
- `GET /api/backup/import-legacy/log` — ประวัติการนำเข้า 50 รายการล่าสุด

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
    interest.js       คำนวณ/ยืนยันจ่ายดอกเบี้ยเงินฝาก-เงินปันผล (Phase 5)
    reports.js        รายงานสรุปผล + ประวัติธุรกรรมแบบละเอียด (Phase 5)
    legacyImport.js   นำเข้าข้อมูลจากไฟล์สำรอง Apps Script เดิม (Phase 6)
migrations/
  0001_init.sql       D1 schema
public/
  index.html          redirect ตาม token ที่มีใน localStorage
  login.html
  app.html            หน้าเว็บหลัก (ฝาก-ถอน, เปิดบัญชี, จัดการผู้ใช้งาน)
```

## งานที่ยังไม่ได้ทำ (เว้นไว้เป็นเฟสถัดไป)

- ปรับโครงสร้างหนี้ (loan restructuring)
- ออกเอกสารราชการแบบฟอร์ม (สัญญาเงินกู้, ใบสำคัญรับเงินแบบราชการ เป็น DOCX) —
  ตอนนี้มีแค่ใบเสร็จพิมพ์ได้แบบง่ายผ่าน `receipt.html`
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
- `CAN_EXPORT_REPORTS` — ดาวน์โหลดรายงาน CSV (Phase 4). สำรอง/กู้คืนฐานข้อมูล
  จำกัดเฉพาะ role ADMIN เท่านั้น ไม่มี permission แยก เพราะเป็นการเข้าถึงข้อมูล
  ทั้งระบบ (รวม password hash)
- `CAN_RUN_INTEREST` — คำนวณ/ยืนยันจ่ายดอกเบี้ยเงินฝากหรือเงินปันผล (Phase 5)
- `CAN_VIEW_REPORTS` — ดูหน้ารายงานสรุปผล (สรุปยอดรวม, สรุปตามชั้น/ห้อง) (Phase 5;
  permission นี้มีมาตั้งแต่ Phase 1 แต่เพิ่งเริ่มใช้งานจริงในเฟสนี้)

Admin มีสิทธิ์ทั้งหมดโดยอัตโนมัติ ส่วน TELLER ต้องเปิดสิทธิ์ที่ต้องการทีละคนผ่าน
`PUT /api/admin/users/:id` (ส่ง `permissions: { "CAN_MANAGE_LOANS": true, ... }`)

## ความปลอดภัย

- รหัสผ่าน: PBKDF2-SHA256, 100,000 รอบ, salt 16 ไบต์ต่อบัญชี
- Login lockout: ล็อก 15 นาทีหลังพยายามผิดครบ 8 ครั้งต่อ username (ปรับได้ที่
  `src/routes/auth.js`)
- Session token: สุ่ม 64 ตัวอักษร (UUID x2) อายุ 12 ชั่วโมง เก็บใน D1 ไม่ใช่ cookie
  (เหมือนเวอร์ชัน Apps Script เดิม)
- ไม่มี endpoint ไหนส่งรหัสผ่าน (hash หรือ plain) กลับไปที่ browser
