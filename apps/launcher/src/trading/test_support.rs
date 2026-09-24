//! Test-binary-only loopback transport. Never reads Windows credentials or
//! contacts the deployed API. Native journeys run in their own child process.
use super::*;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex, OnceLock, atomic::{AtomicBool, Ordering}};

#[derive(Clone)]
pub(crate) struct Connection { pub origin:String, pub token:String, pub root:std::path::PathBuf }
static CONNECTION:OnceLock<Mutex<Option<Connection>>>=OnceLock::new();
pub(crate) fn connection()->Option<Connection> {CONNECTION.get_or_init(Default::default).lock().unwrap().clone()}
pub(crate) fn set_connection(connection:Option<Connection>) {*CONNECTION.get_or_init(Default::default).lock().unwrap()=connection;}

#[derive(Debug, Clone)]
pub(crate) struct Request {pub method:String,pub path:String,pub bearer:String,pub body:Value}
pub(crate) struct Response {pub status:u16,pub body:Value,pub raw:Option<Vec<u8>>,pub drop_response:bool,pub delay:Duration}
impl Response {
    pub fn okay(body:Value)->Self {Self{status:200,body,raw:None,drop_response:false,delay:Duration::ZERO}}
}
pub(crate) struct Server {pub origin:String,pub root:std::path::PathBuf,stop:Arc<AtomicBool>,worker:Option<std::thread::JoinHandle<()>>}
impl Server {
    pub fn new(handler:impl Fn(Request)->Response+Send+Sync+'static)->Self {
        let listener=TcpListener::bind("127.0.0.1:0").unwrap();listener.set_nonblocking(true).unwrap();
        let origin=format!("http://{}",listener.local_addr().unwrap());
        let root=std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.artifacts/trading-fixtures").join(request_uuid().unwrap());
        std::fs::create_dir_all(&root).unwrap();
        let stop=Arc::new(AtomicBool::new(false));let stopping=stop.clone();
        let worker=std::thread::spawn(move || {
            while !stopping.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream,_))=>serve(stream,&handler),
                    Err(error) if error.kind()==std::io::ErrorKind::WouldBlock=>std::thread::sleep(Duration::from_millis(5)),
                    Err(error)=>panic!("Loopback fixture listener failed: {error}"),
                }
            }
        });
        Self{origin,root,stop,worker:Some(worker)}
    }
    pub fn connection(&self,token:&str)->Connection {Connection{origin:self.origin.clone(),root:self.root.clone(),token:token.into()}}
    pub fn api(&self,token:&str)->TradingApi {TradingApi::fixture(self.connection(token))}
}
impl Drop for Server {
    fn drop(&mut self) {self.stop.store(true,Ordering::Relaxed);if let Some(worker)=self.worker.take(){worker.join().unwrap();}}
}
fn serve(stream:TcpStream,handler:&impl Fn(Request)->Response) {
    // Windows accept inherits the listener's nonblocking mode. A read before
    // the first packet arrives must wait, not be mistaken for a closed peer.
    stream.set_nonblocking(false).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    let mut reader=BufReader::new(stream);let mut first=String::new();
    if reader.read_line(&mut first).unwrap_or(0)==0{return;}
    let mut parts=first.split_whitespace();let method=parts.next().unwrap().into();let path=parts.next().unwrap().into();
    let mut length=0;let mut bearer=String::new();
    loop {let mut line=String::new();reader.read_line(&mut line).unwrap();if line=="\r\n"||line.is_empty(){break;}
        if let Some((key,value))=line.split_once(':') {
            if key.eq_ignore_ascii_case("content-length"){length=value.trim().parse::<usize>().unwrap();}
            if key.eq_ignore_ascii_case("authorization"){bearer=value.trim().to_string();}
        }
    }
    assert!(length<=65536);let mut bytes=vec![0;length];reader.read_exact(&mut bytes).unwrap();
    let body=if bytes.is_empty(){Value::Null}else{serde_json::from_slice(&bytes).unwrap()};
    let response=handler(Request{method,path,bearer,body});
    std::thread::sleep(response.delay);
    if response.drop_response{return;}
    let body=response.raw.unwrap_or_else(||response.body.to_string().into_bytes());let mut stream=reader.into_inner();
    let _=write!(stream,"HTTP/1.1 {} Fixture\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",response.status,body.len());
    let _=stream.write_all(&body);
    // Let the client observe the complete response before Winsock releases the
    // socket. Immediate close can race its receive under concurrent test load.
    let _=stream.shutdown(std::net::Shutdown::Write);
    let _=stream.set_read_timeout(Some(Duration::from_millis(100)));
    let _=std::io::copy(&mut stream,&mut std::io::sink());
}

#[test]
#[cfg(windows)] // Exercises request IDs created by the Windows COM implementation.
fn lost_response_recovers_the_exact_request_after_client_restart() {
    use super::tests::{ME,THEM};
    let requests=Arc::new(Mutex::new(Vec::<Request>::new()));let captured=requests.clone();
    let offer=json!({"id":THEM,"revision":2,"status":"accepted","statusReason":null,"senderId":THEM,"participants":[],
        "message":"","items":[],"changedAssetIds":[],"createdAt":"2026-09-07T00:00:00Z","updatedAt":"2026-09-07T00:00:00Z",
        "expiresAt":"2026-09-14T00:00:00Z","completedAt":"2026-09-07T00:00:00Z"});
    let server=Server::new(move |request| {
        if request.path.ends_with("/overview") {return Response::okay(json!({"enabled":true,"player":{"playerId":ME,"displayName":"Fixture","tradeCode":"0123456789abcdef","allowOffers":true},"incomingCount":1,"unreadCount":1,"latestEventId":"1"}));}
        let mut captured=captured.lock().unwrap();captured.push(request);
        Response{drop_response:captured.len()==1,..Response::okay(offer.clone())}
    });
    let pending=PendingMutation::new(ME.into(),Mutation::Respond{offer_id:THEM.into(),revision:2,response:"accept".into(),confirm_gift:true}).unwrap();
    let api=server.api("test-player-a");
    let error=api.mutate(&pending).unwrap_err();assert!(error.status.is_none());
    assert_eq!(api.pending(ME).unwrap(),Some(pending.clone()));drop(api);
    let restarted=server.api("test-player-a");let saved=restarted.pending(ME).unwrap().unwrap();
    assert_eq!(restarted.mutate(&saved).unwrap().status,"accepted");assert!(restarted.pending(ME).unwrap().is_none());
    let requests=requests.lock().unwrap();assert_eq!(requests.len(),2);
    assert_eq!(requests[0].body,requests[1].body);assert_eq!(requests[0].body["requestId"],pending.request_id);
    assert_eq!(requests[0].body["revision"],2);assert_eq!(requests[0].method,"POST");
    assert_eq!(requests[0].bearer,"Bearer test-player-a");
}

#[test]
#[cfg(windows)] // Temporary download names also use Windows COM request IDs.
fn demo_download_authenticates_verifies_and_preserves_existing_files() {
    use sha2::Digest;
    let bytes=b"HL2DEMO\0\xff\x80binary fixture".to_vec();
    let output=Arc::new(Mutex::new(bytes.clone()));let remote=output.clone();
    let server=Server::new(move |request| {
        assert_eq!(request.method,"GET");assert_eq!(request.bearer,"Bearer demo-fixture");
        assert_eq!(request.path,format!("/api/launcher/v1/matches/{}/demo",super::tests::ME));
        Response{raw:Some(remote.lock().unwrap().clone()),..Response::okay(Value::Null)}
    });
    let metadata=json!({"available":true,"sizeBytes":bytes.len(),"checksum":format!("{:x}",sha2::Sha256::digest(&bytes))});
    let api=server.api("demo-fixture");let id=super::tests::ME;
    let target=api.download_demo_to(id,&metadata,&server.root).unwrap();
    assert_eq!(std::fs::read(&target).unwrap(),bytes);
    assert_eq!(api.download_demo_to(id,&metadata,&server.root).unwrap(),target);
    for bad in [vec![1;bytes.len()],vec![2;bytes.len()-1],vec![3;bytes.len()+1]] {
        *output.lock().unwrap()=bad;
        assert!(api.download_demo_to(id,&metadata,&server.root).is_err());
        assert_eq!(std::fs::read(&target).unwrap(),bytes);
        assert!(!std::fs::read_dir(&server.root).unwrap().any(|p|p.unwrap().path().extension().is_some_and(|e|e=="partial")));
    }
    *output.lock().unwrap()=bytes;
    std::fs::write(&target,b"existing unrelated file").unwrap();
    assert!(api.download_demo_to(id,&metadata,&server.root).is_err());
    assert_eq!(std::fs::read(&target).unwrap(),b"existing unrelated file");
    assert!(api.download_demo_to("../escape",&metadata,&server.root).is_err());
}
