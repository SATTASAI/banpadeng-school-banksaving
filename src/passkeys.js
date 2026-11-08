import {handlePasskeys} from './lib/passkeys.js';
import {requireSession,verifyPassword,newSessionToken,SESSION_TTL,jsonOk} from './auth.js';
const lookup=async(r,e,id)=>{const u=await e.DB.prepare('SELECT id,username,display_name,role,active,password_hash FROM users WHERE id=?').bind(id).first();if(!u?.active)return null;u.passkey_version=u.password_hash;return u;};
export const handleBankPasskeys=(request,env)=>handlePasskeys(request,env,{namespace:'bank',lookup,current:async(r,e)=>{const u=await requireSession(r,e);return u?lookup(r,e,u.id):null;},stepUp:async(r,e,u,password)=>verifyPassword(password,u.password_hash),issue:async(r,e,u)=>{
 const token=newSessionToken(),now=Date.now(),expiresAt=now+SESSION_TTL;
 await e.DB.batch([e.DB.prepare('INSERT INTO sessions(token,user_id,expires_at,created_at) VALUES(?,?,?,?)').bind(token,u.id,expiresAt,now),e.DB.prepare('UPDATE users SET last_login_at=? WHERE id=?').bind(now,u.id)]);
 return jsonOk({token,expiresAt,user:{userId:u.id,username:u.username,displayName:u.display_name,role:u.role}},{headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
}});
