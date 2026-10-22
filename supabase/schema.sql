-- Run once in Supabase: SQL Editor > New query > paste > Run
create extension if not exists btree_gist;
create table profiles(id uuid primary key default gen_random_uuid(),name text not null,email text unique not null,password_hash text not null,role text not null check(role in('admin','manager','cashier','kitchen')),active boolean default true,created_at timestamptz default now());
create table categories(id serial primary key,name text unique not null);
create table menu_items(id serial primary key,name text not null,description text,image_url text,category_id int references categories on delete set null,price numeric(10,2) not null check(price>=0),available boolean default true,prep_minutes int default 15 check(prep_minutes>=0));
create table ingredients(id serial primary key,name text unique not null,unit text not null,cost numeric(10,2) default 0 check(cost>=0),qty numeric(12,3) default 0,min_qty numeric(12,3) default 0);
create table recipes(id serial primary key,menu_item_id int not null references menu_items on delete cascade,ingredient_id int not null references ingredients on delete restrict,qty numeric(12,3) not null check(qty>0),unique(menu_item_id,ingredient_id));
create table inventory_transactions(id bigserial primary key,ingredient_id int not null references ingredients,change numeric(12,3) not null,reason text not null,ref text,created_at timestamptz default now());
create unique index no_double_deduction on inventory_transactions(ref,ingredient_id) where reason='order';
create table suppliers(id serial primary key,name text not null,phone text,address text);
create table purchases(id serial primary key,supplier_id int not null references suppliers,status text default 'ordered' check(status in('ordered','received','cancelled')),total numeric(12,2) default 0,paid numeric(12,2) default 0 check(paid>=0),created_at timestamptz default now());
create table purchase_items(id serial primary key,purchase_id int not null references purchases on delete cascade,ingredient_id int not null references ingredients,qty numeric(12,3) not null check(qty>0),unit_cost numeric(10,2) not null check(unit_cost>=0));
create table restaurant_tables(id serial primary key,number text unique not null,capacity int not null check(capacity>0),status text default 'available' check(status in('available','occupied','reserved','cleaning')));
create table customers(id serial primary key,name text not null,phone text unique,address text,points int default 0 check(points>=0));
create table reservations(id serial primary key,table_id int not null references restaurant_tables,customer_id int references customers,guest_name text,starts_at timestamptz not null,ends_at timestamptz not null,status text default 'booked' check(status in('booked','seated','cancelled','completed')),check(ends_at>starts_at),exclude using gist(table_id with =,tstzrange(starts_at,ends_at) with &&) where (status='booked'));
create sequence order_seq;
create table orders(id bigserial primary key,number text unique not null,idem_key text unique,type text not null check(type in('dine_in','takeaway','delivery')),status text default 'pending' check(status in('pending','confirmed','preparing','ready','out_for_delivery','completed','cancelled')),table_id int references restaurant_tables,customer_id int references customers,delivery_address text,delivery_staff text,delivery_charge numeric(10,2) default 0,payment_method text,notes text,subtotal numeric(12,2) not null,discount numeric(12,2) default 0,tax numeric(12,2) default 0,total numeric(12,2) not null,paid numeric(12,2) default 0,payment_status text default 'unpaid' check(payment_status in('unpaid','partial','paid','refunded')),stock_deducted boolean default false,created_by uuid references profiles,created_at timestamptz default now());
create index on orders(status);create index on orders(created_at);
create table order_items(id bigserial primary key,order_id bigint not null references orders on delete cascade,menu_item_id int references menu_items,name text not null,price numeric(10,2) not null,qty int not null check(qty>0),note text);
create table payments(id bigserial primary key,order_id bigint not null references orders,method text not null check(method in('cash','card','digital')),amount numeric(12,2) not null check(amount>0),kind text default 'payment' check(kind in('payment','refund')),reference text,verified boolean default false,created_at timestamptz default now());
create table expenses(id serial primary key,category text not null,description text,amount numeric(12,2) not null check(amount>0),spent_on date default current_date);
create table staff(id serial primary key,name text not null,job_title text,phone text,salary numeric(12,2) default 0);
create table attendance(id serial primary key,staff_id int not null references staff on delete cascade,day date not null default current_date,shift text,check_in time,check_out time,unique(staff_id,day));
create table settings(id serial primary key,key text unique not null,value text);
insert into settings(key,value) values('restaurant_name','My Restaurant'),('tax_rate','16');

-- RLS on with no policies: the public anon key can read nothing.
-- Only the backend (service-role key in .env) accesses data.
do $$ declare t text; begin for t in select tablename from pg_tables where schemaname='public' loop execute format('alter table %I enable row level security',t); end loop; end $$;

create or replace function recalc_order(p_id bigint) returns void language plpgsql as $$
declare v numeric; t numeric; begin
 select coalesce(sum(case when kind='payment' then amount else -amount end),0) into v from payments where order_id=p_id and verified;
 select total into t from orders where id=p_id;
 update orders set paid=v,payment_status=case when v<=0 and exists(select 1 from payments where order_id=p_id and kind='refund') then 'refunded' when v<=0 then 'unpaid' when v>=t then 'paid' else 'partial' end where id=p_id;
end $$;

create or replace function create_order(p jsonb) returns orders language plpgsql as $$
declare o orders; it jsonb; m menu_items; sub numeric:=0; rate numeric; disc numeric; tx numeric; dc numeric; begin
 if p->>'idem_key' is not null then select * into o from orders where idem_key=p->>'idem_key'; if found then return o; end if; end if;
 if jsonb_array_length(coalesce(p->'items','[]'::jsonb))=0 then raise exception 'Add at least one item'; end if;
 for it in select * from jsonb_array_elements(p->'items') loop
  select * into m from menu_items where id=(it->>'menu_item_id')::int and available;
  if not found then raise exception 'An item is unavailable'; end if;
  if (it->>'qty')::int<1 then raise exception 'Quantity must be at least 1'; end if;
  sub:=sub+m.price*(it->>'qty')::int;
 end loop;
 select coalesce((select value::numeric from settings where key='tax_rate'),0) into rate;
 disc:=least(greatest(coalesce(nullif(p->>'discount','')::numeric,0),0),sub);
 dc:=case when p->>'type'='delivery' then greatest(coalesce(nullif(p->>'delivery_charge','')::numeric,0),0) else 0 end;
 tx:=round((sub-disc)*rate/100,2);
 insert into orders(number,idem_key,type,table_id,customer_id,delivery_address,delivery_charge,payment_method,notes,subtotal,discount,tax,total,created_by)
 values('ORD-'||to_char(now(),'YYMMDD')||'-'||lpad(nextval('order_seq')::text,4,'0'),p->>'idem_key',p->>'type',nullif(p->>'table_id','')::int,nullif(p->>'customer_id','')::int,p->>'delivery_address',dc,p->>'payment_method',p->>'notes',sub,disc,tx,sub-disc+tx+dc,nullif(p->>'created_by','')::uuid) returning * into o;
 for it in select * from jsonb_array_elements(p->'items') loop
  insert into order_items(order_id,menu_item_id,name,price,qty,note) select o.id,m2.id,m2.name,m2.price,(it->>'qty')::int,it->>'note' from menu_items m2 where m2.id=(it->>'menu_item_id')::int;
 end loop;
 if o.type='dine_in' and o.table_id is not null then update restaurant_tables set status='occupied' where id=o.table_id; end if;
 return o; end $$;

create or replace function set_order_status(p_id bigint,p_status text) returns orders language plpgsql as $$
declare o orders; x record; begin
 select * into o from orders where id=p_id for update;
 if not found then raise exception 'Order not found'; end if;
 if o.status in('completed','cancelled') then raise exception 'Order is already %',o.status; end if;
 update orders set status=p_status where id=p_id returning * into o;
 if p_status='completed' and not o.stock_deducted then
  for x in select rc.ingredient_id i,sum(rc.qty*oi.qty) q from order_items oi join recipes rc on rc.menu_item_id=oi.menu_item_id where oi.order_id=p_id group by rc.ingredient_id loop
   update ingredients set qty=qty-x.q where id=x.i;
   insert into inventory_transactions(ingredient_id,change,reason,ref) values(x.i,-x.q,'order',o.number);
  end loop;
  update orders set stock_deducted=true where id=p_id;
 end if;
 if p_status in('completed','cancelled') and o.type='dine_in' and o.table_id is not null then update restaurant_tables set status='cleaning' where id=o.table_id; end if;
 return o; end $$;

create or replace function record_payment(p_order bigint,p_method text,p_amount numeric,p_kind text,p_ref text) returns payments language plpgsql as $$
declare o orders; committed numeric; pay payments; begin
 select * into o from orders where id=p_order for update;
 if not found or o.status='cancelled' then raise exception 'Order not found or cancelled'; end if;
 select coalesce(sum(case when kind='payment' then amount else -amount end),0) into committed from payments where order_id=p_order;
 if p_kind='payment' and p_amount>o.total-committed then raise exception 'Amount is more than the balance due'; end if;
 if p_kind='refund' and p_amount>o.paid then raise exception 'Refund is more than the verified amount paid'; end if;
 insert into payments(order_id,method,amount,kind,reference,verified) values(p_order,p_method,p_amount,p_kind,p_ref,p_method='cash' or p_kind='refund') returning * into pay;
 perform recalc_order(p_order); return pay; end $$;

create or replace function verify_payment(p_id bigint) returns void language plpgsql as $$
declare oid bigint; begin
 update payments set verified=true where id=p_id and not verified returning order_id into oid;
 if oid is null then raise exception 'Payment not found or already verified'; end if;
 perform recalc_order(oid); end $$;

create or replace function receive_purchase(p_id int) returns purchases language plpgsql as $$
declare p purchases; x record; begin
 select * into p from purchases where id=p_id for update;
 if not found or p.status<>'ordered' then raise exception 'Only open purchase orders can be received'; end if;
 for x in select * from purchase_items where purchase_id=p_id loop
  update ingredients set qty=qty+x.qty,cost=x.unit_cost where id=x.ingredient_id;
  insert into inventory_transactions(ingredient_id,change,reason,ref) values(x.ingredient_id,x.qty,'purchase','PO-'||p_id);
 end loop;
 update purchases set status='received' where id=p_id returning * into p; return p; end $$;

create or replace function pay_purchase(p_id int,p_amt numeric) returns purchases language plpgsql as $$
declare p purchases; begin
 update purchases set paid=paid+p_amt where id=p_id and p_amt>0 and paid+p_amt<=total and status<>'cancelled' returning * into p;
 if not found then raise exception 'Invalid payment amount'; end if; return p; end $$;

create or replace function adjust_stock(p_id int,p_change numeric,p_reason text) returns void language plpgsql as $$
begin
 update ingredients set qty=qty+p_change where id=p_id;
 if not found then raise exception 'Ingredient not found'; end if;
 insert into inventory_transactions(ingredient_id,change,reason) values(p_id,p_change,coalesce(nullif(p_reason,''),'adjustment')); end $$;
