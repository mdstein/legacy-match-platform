import { createConnection } from "@aftertick/db";
import { setTradingEnabled, tradingStatus } from "./trading-operations.js";
import { TradingService } from "./trading-service.js";

const [action="status",...args]=process.argv.slice(2);
if (!['status','enable','disable','expire'].includes(action) ||
  (['enable','disable'].includes(action)?args.length!==2||args[0]!=="--reason":args.length!==0)) {
  throw new Error('Usage: npm run trading:control -- status|expire|enable --reason "..."|disable --reason "..."');
}
const url=process.env["DATABASE_URL"];
if(!url)throw new Error("Set DATABASE_URL explicitly for the intended database.");
const sql=createConnection(url);
try {
  if(action==='enable'||action==='disable')await setTradingEnabled(sql,action==='enable',args[1]!);
  if(action==='expire')console.log(JSON.stringify({expired:await new TradingService(sql).expireOffers()}));
  console.log(JSON.stringify(await tradingStatus(sql),null,2));
} finally {await sql.end();}
