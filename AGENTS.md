# AGENTS.md — BPD School Bank — ธนาคารโรงเรียน (banpadeng-school-banksaving)

ระบบธนาคารโรงเรียนรุ่น Cloudflare Worker + D1: บัญชีออม ฝาก-ถอน Bank Session เงินกู้ ดอกเบี้ย ปิดบัญชี ส่งมอบเงินสด เลื่อนชั้น/จบการศึกษา สำรอง/กู้คืน และใบเสร็จ

## ข้อมูลระบบ

- Cloudflare Worker `banpadeng-school-banksaving` + `public/`
- D1 `DB` = `banksaving-sandbox-db` (ฐานทดลอง) · แยก login/ฐานข้อมูล/โดเมนจาก banpadeng-school-db
- ระบบเงินจริงที่ใช้งานอยู่ใช้ฐาน `banpadeng-school-bank-db` (ดู school-bank-appsscript) — ห้ามชี้รีโปนี้ไปฐานนั้นโดยไม่ได้สั่ง

## วิธีทำงานในรีโปนี้ (สำหรับ agent)

1. อ่านไฟล์นี้, `README.md` และเอกสารใน `docs/` (ถ้ามี) ก่อนแก้ทุกครั้ง
2. ทำเฉพาะขอบเขตที่ได้รับมอบหมาย ไม่ refactor, ไม่เปลี่ยนชื่อไฟล์/ตาราง/endpoint และไม่อัปเกรด dependency ถ้าไม่ได้สั่ง
3. ถ้างานกระทบข้อมูลจริง สิทธิ์ผู้ใช้ เงิน หรือระบบอื่น ให้หยุดถามก่อนลงมือ
4. แก้ให้น้อยที่สุดที่ทำให้งานสำเร็จ และเขียน/ปรับ test ที่ครอบคลุมพฤติกรรมที่เปลี่ยน
5. รันคำสั่งตรวจในหัวข้อ "คำสั่ง" ให้ผ่านทั้งหมดก่อน commit
6. ตอบผู้ใช้เป็นภาษาไทย กระชับ ข้อความ UI ทั้งหมดเป็นภาษาไทย

## คำสั่ง

```sh
npm ci
npm test                         # node --test tests/*.test.mjs
npm run dev                      # wrangler dev
npm run db:migrate:local         # ใช้ฐาน local เท่านั้น
```

## โครงสร้างไฟล์

```
src/index.js        → router
src/routes/         → accounts, transactions, banksession, loans, interest, handover, academic, backup, exports, reports, legacyImport, admin, auth
src/money.js        → เงินเป็นสตางค์ (INTEGER)
src/loanmath.js     → ตารางผ่อน (คงที่/ลดต้นลดดอก), waterfall, ค่าปรับ
src/permissions.js, src/auth.js, src/passkeys.js
migrations/         → 0001–0007 (เพิ่มไฟล์ใหม่ ห้ามแก้ไฟล์เดิม)
public/             → app.html, login.html, receipt.html
```

## ฐานข้อมูล

- schema เปลี่ยนด้วยไฟล์ `migrations/000N_*.sql` ใหม่เท่านั้น
- `db:migrate:remote` และคำสั่ง `--remote` ใดๆ ห้ามรันโดยไม่ได้สั่ง

## กติกาเฉพาะของระบบ (business rules)

- เงินเก็บเป็นสตางค์ (1 บาท = 100) ห้ามใช้ float ในการคิดเงิน
- ยกเลิก/แก้รายการย้อนหลัง = สร้างรายการกลับที่ตรวจยอดคงเหลือ ห้ามแก้/ลบแถวเดิม
- ปิดบัญชีถูกบล็อกถ้ายอดไม่เป็น 0 หรือมีเงินกู้ค้าง (`memberHasOpenLoan()`)
- จบการศึกษา/purge: preview ก่อน, พิมพ์ข้อความยืนยันตรงทุกตัว, token อายุ 5 นาทีผูกแอดมิน, เก็บ snapshot ใน `graduation_batches`
- restore ลบข้อมูลทั้งหมดแล้วแทนที่: ต้องพิมพ์ยืนยัน · Admin เท่านั้น
- ส่งมอบเงินสดต้องให้ผู้รับยืนยัน · รายการฝาก-ถอนต้องอยู่ใน Bank Session ที่เปิด

## ข้อตกลงการเขียนโค้ด

- เวลาและวันที่อิงเวลาไทย `Asia/Bangkok` (UTC+7) ทุกจุด ทั้งการคำนวณวัน ตัดรอบ และ cron; แสดงปีเป็น พ.ศ. แต่เก็บเป็น ISO/ค.ศ.
- SQL ใช้ prepared statement + `.bind()` เท่านั้น ห้ามต่อสตริงจากค่าที่ผู้ใช้ส่งมา
- ตรวจสิทธิ์ฝั่งเซิร์ฟเวอร์ทุก endpoint (role/status/session ปัจจุบันจากฐาน) อย่าเชื่อค่าจากหน้าเว็บ
- งานที่เขียนหลายแถวต้องเป็น atomic (`db.batch()`) และกันกดซ้ำ (idempotency key) เมื่อเป็นรายการเงินหรือรายการสำคัญ
- การลบข้อมูลสำคัญใช้ soft delete/ยกเลิกพร้อมเหตุผล และบันทึก audit แทนการลบแถว
- หน้าเว็บต้องใช้ได้บนมือถือ (iPhone Safari/PWA) และจอกว้าง ใช้ฟอนต์และสไตล์เดิมของรีโป
- escape ข้อความก่อนใส่ลง HTML เสมอ (กัน XSS) และอย่าเพิ่ม CDN/สคริปต์ภายนอกใหม่ถ้าไม่จำเป็น

## ความปลอดภัยและ secrets

- ห้าม commit secret, token, รหัสผ่าน, `.env`, `.dev.vars`, ไฟล์สำรองฐานข้อมูล หรือข้อมูลนักเรียน/บุคลากรจริงลง Git
- secret ตั้งผ่าน Cloudflare dashboard หรือ `wrangler secret put` เท่านั้น (`keep_vars: true` ทำให้ค่าที่ตั้งใน dashboard ไม่ถูกทับ)
- ข้อมูลนักเรียนเป็นข้อมูลส่วนบุคคลของผู้เยาว์: ห้าม log ชื่อ เลขประจำตัว ที่อยู่ หรือข้อมูลผู้ปกครองลง console/observability
- ห้ามปิดหรือผ่อนการตรวจสิทธิ์ การจำกัดความถี่ล็อกอิน Turnstile หรือ passkey เพื่อให้ทดสอบง่าย

## ห้ามแตะ / ต้องระวังเป็นพิเศษ

- `src/money.js`, `src/loanmath.js`, `src/routes/transactions.js`, `loans.js`, `backup.js`
- migration เดิมใน `migrations/`

## Deploy

- ไม่มีการเชื่อม deploy อัตโนมัติที่ยืนยันได้ — deploy (`npm run deploy`) เฉพาะเมื่อผู้ใช้สั่ง

## Checklist ก่อนเปิด PR / merge

- [ ] test เรื่องยอดเงิน/ดอกเบี้ย/เงินกู้ที่เกี่ยวข้องผ่าน และตัวเลขตรวจด้วยมือแล้ว
- [ ] test และ syntax check ทั้งหมดผ่าน
- [ ] ไม่มี secret/ข้อมูลจริงใน diff (`git diff --cached` ตรวจก่อน commit)
- [ ] ไม่แก้ `database_id`, `routes`, `services` และชื่อ Worker ใน wrangler config โดยไม่ได้สั่ง
- [ ] schema เปลี่ยนแบบเพิ่มเท่านั้น (add table/column) และรันซ้ำได้ ไม่ทำให้ข้อมูลเดิมหรือระบบอื่นพัง
- [ ] อัปเดต `README.md`/`docs/` เมื่อพฤติกรรมหรือขั้นตอนติดตั้งเปลี่ยน และบันทึกการตัดสินใจถาวรของผู้ใช้ลงไฟล์นี้
- [ ] commit/PR อธิบายเป็นภาษาไทยว่าเปลี่ยนอะไร เพราะอะไร และทดสอบอย่างไร
