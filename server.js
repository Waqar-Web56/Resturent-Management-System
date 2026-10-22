require('dotenv').config();
const express=require('express'),helmet=require('helmet'),cors=require('cors'),rate=require('express-rate-limit'),bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken'),{createClient}=require('@supabase/supabase-js');
const {SUPABASE_URL,SUPABASE_SERVICE_KEY,JWT_SECRET,PORT=3000,CORS_ORIGIN}=process.env;
if(!SUPABASE_URL||!SUPABASE_SERVICE_KEY||!JWT_SECRET||JWT_SECRET.length<32){console.error('Set SUPABASE_URL, SUPABASE_SERVICE_KEY and a JWT_SECRET of 32+ characters in .env');process.exit(1)}
const db=createClient(SUPABASE_URL,SUPABASE_SERVICE_KEY,{auth:{persistSession:false}});
const app=express();app.use(helmet({contentSecurityPolicy:false}),cors({origin:CORS_ORIGIN||false}),express.json({limit:'100kb'}),express.static('public'));
const ok=async p=>{const{data,error}=await p;if(error)throw Object.assign(new Error({'23P01':'That table is already booked for this time','23503':'This record is used by other records','23505':'A record with this value already exists'}[error.code]||error.message),{status:400});return data};
const ah=f=>(q,s,n)=>f(q,s,n).catch(n);
const auth=(q,s,n)=>{try{q.user=jwt.verify((q.headers.authorization||'').slice(7),JWT_SECRET);n()}catch{s.status(401).json({error:'Please sign in again'})}};
const need=(...r)=>(q,s,n)=>q.user.role==='admin'||r.includes(q.user.role)?n():s.status(403).json({error:'Your role cannot do this'});
const ST=['pending','confirmed','preparing','ready','out_for_delivery','completed','cancelled'];

app.post('/api/auth/login',rate({windowMs:9e5,max:20}),ah(async(q,s)=>{
 const{data:u}=await db.from('profiles').select('*').eq('email',String(q.body.email||'').trim().toLowerCase()).eq('active',true).maybeSingle();
 if(!u||!await bcrypt.compare(String(q.body.password||''),u.password_hash))return s.status(401).json({error:'Invalid email or password'});
 const user={id:u.id,name:u.name,role:u.role},{data:r}=await db.from('settings').select('value').eq('key','restaurant_name').maybeSingle();
 s.json({token:jwt.sign(user,JWT_SECRET,{expiresIn:'8h'}),user,restaurant:r?.value||'Restaurant'})}));

const api=express.Router();api.use(auth);

// ---- Orders, kitchen, delivery, billing
api.get('/orders',need('manager','cashier','kitchen'),ah(async(q,s)=>s.json(await ok(db.from('orders').select('*,order_items(*),restaurant_tables(number),customers(name,phone),payments(*)').order('id',{ascending:false}).limit(300)))));
api.post('/orders',need('manager','cashier'),ah(async(q,s)=>{const b=q.body;s.json(await ok(db.rpc('create_order',{p:{...b,created_by:q.user.id,items:(b.items||[]).map(i=>({menu_item_id:i.menu_item_id,qty:i.qty,note:i.note}))}})))}));
api.patch('/orders/:id/status',need('manager','cashier','kitchen'),ah(async(q,s)=>{const st=q.body.status;if(!(q.user.role==='kitchen'?['preparing','ready']:ST).includes(st))return s.status(403).json({error:'You cannot set that status'});s.json(await ok(db.rpc('set_order_status',{p_id:+q.params.id,p_status:st})))}));
api.patch('/orders/:id/delivery',need('manager','cashier'),ah(async(q,s)=>s.json(await ok(db.from('orders').update({delivery_staff:q.body.delivery_staff||null,delivery_address:q.body.delivery_address||null}).eq('id',q.params.id).eq('type','delivery').select().single()))));
api.post('/orders/:id/payments',need('manager','cashier'),ah(async(q,s)=>{const{method,amount,kind='payment',reference}=q.body;
 if(!['cash','card','digital'].includes(method)||!(+amount>0)||!['payment','refund'].includes(kind))return s.status(400).json({error:'Check the method and amount'});
 if(method!=='cash'&&!reference)return s.status(400).json({error:'Enter the card or wallet reference number'});
 if(kind==='refund'&&!['admin','manager'].includes(q.user.role))return s.status(403).json({error:'Only a manager can refund'});
 s.json(await ok(db.rpc('record_payment',{p_order:+q.params.id,p_method:method,p_amount:+amount,p_kind:kind,p_ref:reference||null})))}));
api.post('/payments/:id/verify',need('manager'),ah(async(q,s)=>{await ok(db.rpc('verify_payment',{p_id:+q.params.id}));s.json({ok:true})}));

// ---- Purchases & inventory
api.get('/purchases',need('manager'),ah(async(q,s)=>s.json(await ok(db.from('purchases').select('*,suppliers(name),purchase_items(*,ingredients(name,unit))').order('id',{ascending:false})))));
api.post('/purchases',need('manager'),ah(async(q,s)=>{const{supplier_id,items}=q.body;
 if(!supplier_id||!Array.isArray(items)||!items.length||items.some(i=>!(+i.qty>0)||!(+i.unit_cost>=0)))return s.status(400).json({error:'Choose a supplier and add valid lines'});
 const p=await ok(db.from('purchases').insert({supplier_id,total:items.reduce((a,i)=>a+i.qty*i.unit_cost,0)}).select().single());
 try{await ok(db.from('purchase_items').insert(items.map(i=>({purchase_id:p.id,ingredient_id:i.ingredient_id,qty:i.qty,unit_cost:i.unit_cost}))))}catch(e){await db.from('purchases').delete().eq('id',p.id);throw e}s.json(p)}));
api.post('/purchases/:id/receive',need('manager'),ah(async(q,s)=>s.json(await ok(db.rpc('receive_purchase',{p_id:+q.params.id})))));
api.post('/purchases/:id/pay',need('manager'),ah(async(q,s)=>s.json(await ok(db.rpc('pay_purchase',{p_id:+q.params.id,p_amt:+q.body.amount})))));
api.post('/ingredients/:id/adjust',need('manager'),ah(async(q,s)=>{if(!+q.body.change)return s.status(400).json({error:'Enter a non-zero change'});await ok(db.rpc('adjust_stock',{p_id:+q.params.id,p_change:+q.body.change,p_reason:q.body.reason}));s.json({ok:true})}));

// ---- Dashboard, reports, notifications
const sum=(a,f)=>a.reduce((t,x)=>t+Number(f(x)||0),0),day=d=>new Date(d).toISOString().slice(0,10);
api.get('/dashboard',need('manager'),ah(async(q,s)=>{
 const[o,e,t,i,it]=await Promise.all([ok(db.from('orders').select('id,number,type,status,total,created_at').order('id',{ascending:false}).limit(2000)),ok(db.from('expenses').select('amount')),ok(db.from('restaurant_tables').select('status')),ok(db.from('ingredients').select('name,qty,min_qty')),ok(db.from('order_items').select('name,qty,orders!inner(status)').eq('orders.status','completed').limit(3000))]);
 const done=o.filter(x=>x.status==='completed'),today=day(new Date()),sales=sum(done,x=>x.total),exp=sum(e,x=>x.amount),series={};
 for(let k=13;k>=0;k--)series[day(Date.now()-k*864e5)]=0;done.forEach(x=>{const d=day(x.created_at);if(d in series)series[d]+=+x.total});
 const pop={};it.forEach(x=>pop[x.name]=(pop[x.name]||0)+x.qty);
 s.json({sales,today:sum(done.filter(x=>day(x.created_at)===today),x=>x.total),orders:o.length,pending:o.filter(x=>x.status==='pending').length,tables:t.filter(x=>x.status==='available').length,expenses:exp,profit:sales-exp,low:i.filter(x=>+x.qty<=+x.min_qty),series,popular:Object.entries(pop).sort((a,b)=>b[1]-a[1]).slice(0,5),recent:o.slice(0,8)})}));
api.get('/reports',need('manager'),ah(async(q,s)=>{
 const from=q.query.from||'1970-01-01',to=(q.query.to||'2999-12-31')+'T23:59:59';
 const[o,p,e,it,pu]=await Promise.all([ok(db.from('orders').select('total,paid,status,created_at').gte('created_at',from).lte('created_at',to)),ok(db.from('payments').select('amount,kind,verified').eq('verified',true).gte('created_at',from).lte('created_at',to)),ok(db.from('expenses').select('amount').gte('spent_on',from.slice(0,10)).lte('spent_on',to.slice(0,10))),ok(db.from('order_items').select('name,qty,orders!inner(status,created_at)').eq('orders.status','completed').gte('orders.created_at',from).lte('orders.created_at',to)),ok(db.from('purchases').select('total,paid').neq('status','cancelled'))]);
 const done=o.filter(x=>x.status==='completed'),pop={},revenue=sum(done,x=>x.total),exp=sum(e,x=>x.amount);it.forEach(x=>pop[x.name]=(pop[x.name]||0)+x.qty);
 s.json({revenue,cash_in:sum(p,x=>x.kind==='payment'?x.amount:-x.amount),expenses:exp,estimated_profit:revenue-exp,customer_outstanding:sum(o.filter(x=>x.status!=='cancelled'),x=>x.total-x.paid),supplier_outstanding:sum(pu,x=>x.total-x.paid),orders:o.length,best:Object.entries(pop).sort((a,b)=>b[1]-a[1]).slice(0,10)})}));
api.get('/notifications',ah(async(q,s)=>{const n=[];
 if(['admin','manager'].includes(q.user.role)){
  (await ok(db.from('ingredients').select('name,qty,min_qty,unit'))).filter(x=>+x.qty<=+x.min_qty).forEach(x=>n.push({t:'Low stock',m:`${x.name}: ${x.qty} ${x.unit} left (minimum ${x.min_qty})`}));
  const up=await ok(db.from('payments').select('id',{count:'exact'}).eq('verified',false));if(up.length)n.push({t:'Payments to verify',m:`${up.length} card or wallet payment(s) wait for verification`})}
 const pend=await ok(db.from('orders').select('id').eq('status','pending'));if(pend.length)n.push({t:'Pending orders',m:`${pend.length} order(s) are waiting to be confirmed`});
 if(['admin','manager','cashier'].includes(q.user.role)){(await ok(db.from('reservations').select('starts_at,guest_name,restaurant_tables(number)').eq('status','booked').gte('starts_at',new Date().toISOString()).lte('starts_at',new Date(Date.now()+72e5).toISOString()))).forEach(r=>n.push({t:'Reservation soon',m:`Table ${r.restaurant_tables?.number}, ${r.guest_name||'guest'}, ${new Date(r.starts_at).toLocaleTimeString([],{timeStyle:'short'})}`}))}
 s.json(n)}));

// ---- Users (admin only; passwords hashed with bcrypt, never returned)
api.get('/profiles',need(),ah(async(q,s)=>s.json(await ok(db.from('profiles').select('id,name,email,role,active').order('name')))));
api.post('/profiles',need(),ah(async(q,s)=>{const{name,email,role,password}=q.body;if(!name||!/^\S+@\S+$/.test(email||'')||String(password||'').length<8)return s.status(400).json({error:'Name, valid email and a password of 8+ characters are required'});
 s.json(await ok(db.from('profiles').insert({name,email:email.toLowerCase(),role,password_hash:await bcrypt.hash(password,12)}).select('id,name,email,role,active').single()))}));
api.patch('/profiles/:id',need(),ah(async(q,s)=>{const u={};for(const k of['name','role','active'])if(k in q.body)u[k]=q.body[k];
 if(q.body.password){if(q.body.password.length<8)return s.status(400).json({error:'Password needs 8+ characters'});u.password_hash=await bcrypt.hash(q.body.password,12)}
 if(q.params.id===q.user.id&&(u.active===false||(u.role&&u.role!=='admin')))return s.status(400).json({error:'You cannot lock yourself out'});
 s.json(await ok(db.from('profiles').update(u).eq('id',q.params.id).select('id,name,email,role,active').single()))}));

// ---- Generic CRUD with field whitelists and role checks
const M='manager',C='cashier',RES={
 categories:{f:['name'],r:'*',w:[M]},
 menu_items:{f:['name','description','image_url','category_id','price','available','prep_minutes'],r:'*',w:[M]},
 restaurant_tables:{f:['number','capacity','status'],r:'*',w:[M,C]},
 reservations:{f:['table_id','customer_id','guest_name','starts_at','ends_at','status'],r:[M,C],w:[M,C]},
 customers:{f:['name','phone','address','points'],r:[M,C],w:[M,C]},
 ingredients:{f:['name','unit','cost','min_qty'],r:[M],w:[M]},
 recipes:{f:['menu_item_id','ingredient_id','qty'],r:[M],w:[M]},
 inventory_transactions:{f:[],r:[M],w:[]},
 suppliers:{f:['name','phone','address'],r:[M],w:[M]},
 expenses:{f:['category','description','amount','spent_on'],r:[M],w:[M]},
 staff:{f:['name','job_title','phone','salary'],r:[M],w:[M]},
 attendance:{f:['staff_id','day','shift','check_in','check_out'],r:[M],w:[M]},
 settings:{f:['key','value'],r:[M],w:[M]}};
const has=(r,u)=>u.role==='admin'||r==='*'||r.includes(u.role);
const res=(q,s,n,w)=>{const c=RES[q.params.res];if(!c)return n('route');if(!has(w?c.w:c.r,q.user))return s.status(403).json({error:'Your role cannot do this'});q.cfg=c;n()};
const pick=(b,f)=>Object.fromEntries(f.filter(k=>k in b).map(k=>[k,b[k]===''?null:b[k]]));
api.get('/:res',(q,s,n)=>res(q,s,n,0),ah(async(q,s)=>s.json(await ok(db.from(q.params.res).select('*').order('id',{ascending:false}).limit(500)))));
api.post('/:res',(q,s,n)=>res(q,s,n,1),ah(async(q,s)=>s.json(await ok(db.from(q.params.res).insert(pick(q.body,q.cfg.f)).select().single()))));
api.patch('/:res/:id',(q,s,n)=>res(q,s,n,1),ah(async(q,s)=>s.json(await ok(db.from(q.params.res).update(pick(q.body,q.cfg.f)).eq('id',q.params.id).select().single()))));
api.delete('/:res/:id',(q,s,n)=>res(q,s,n,1),ah(async(q,s)=>{await ok(db.from(q.params.res).delete().eq('id',q.params.id));s.json({ok:true})}));
app.use('/api',api);
app.use('/api',(q,s)=>s.status(404).json({error:'Not found'}));
app.use((e,q,s,n)=>{if(e==='route')return s.status(404).json({error:'Not found'});s.status(e.status||500).json({error:e.status?e.message:'Server error'});if(!e.status)console.error(e)});
app.listen(PORT,()=>console.log('Restaurant system on http://localhost:'+PORT));
