require('dotenv').config();
const{createClient}=require('@supabase/supabase-js'),bcrypt=require('bcryptjs');
const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_KEY,{auth:{persistSession:false}});
const up=async(t,rows,opt)=>{const{error}=await db.from(t).upsert(rows,opt);if(error)throw new Error(t+': '+error.message)};
(async()=>{
 const{ADMIN_EMAIL:e,ADMIN_PASSWORD:p}=process.env;
 if(e&&p)await up('profiles',[{name:'Admin',email:e.toLowerCase(),role:'admin',password_hash:await bcrypt.hash(p,12)}],{onConflict:'email'});
 await up('categories',['Fast Food','Pakistani Food','Chinese','Drinks','Desserts','BBQ'].map(name=>({name})),{onConflict:'name'});
 await up('restaurant_tables',[1,2,3,4,5,6].map(n=>({number:'T'+n,capacity:n<4?2:4})),{onConflict:'number'});
 const{data:c}=await db.from('categories').select('id,name'),id=n=>c.find(x=>x.name===n).id;
 const{data:m}=await db.from('menu_items').select('id').limit(1);
 if(!m.length)await db.from('menu_items').insert([['Chicken Karahi',1450,'Pakistani Food',25],['Chicken Biryani',650,'Pakistani Food',20],['Zinger Burger',520,'Fast Food',12],['Chicken Chowmein',750,'Chinese',15],['Seekh Kabab (6 pcs)',900,'BBQ',20],['Mint Margarita',280,'Drinks',5],['Gulab Jamun',250,'Desserts',3]].map(([name,price,k,prep_minutes])=>({name,price,category_id:id(k),prep_minutes})));
 await up('ingredients',[{name:'Chicken',unit:'kg',cost:650,qty:20,min_qty:5},{name:'Rice',unit:'kg',cost:300,qty:30,min_qty:8}],{onConflict:'name'});
 console.log('Seed complete. Sign in as',e||'(set ADMIN_EMAIL in .env to create an admin)');
})().catch(x=>{console.error(x.message);process.exit(1)});
