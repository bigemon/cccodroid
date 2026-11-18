package cc.codroid;

import android.content.Context;
import android.net.Uri;
import android.os.PowerManager;
import org.json.JSONObject;
import java.io.*;
import java.nio.file.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Native-only orchestration. JS can request a picker/dialog, never choose a path or approve a restore. */
final class FullBackupController {
    private static final ExecutorService WORK=Executors.newSingleThreadExecutor(r->new Thread(r,"full-backup"));
    private static final AtomicBoolean CANCEL=new AtomicBoolean();
    private static volatile boolean active,maintenance,restartRequired;
    private static volatile String phase="idle",message="",path="",operation="";
    private static volatile long done,total,updated,estimated,available=-1,spaceReserve;
    private static volatile FullBackup.Manifest verified;
    private static volatile int currentVersion;
    private static volatile String currentVersionName="";
    private static volatile Context ctx;
    private static volatile PowerManager.WakeLock wake;
    static FullBackup engine(Context c)throws IOException{
        android.content.pm.PackageInfo info;
        try{info=c.getPackageManager().getPackageInfo(c.getPackageName(),0);}
        catch(Exception e){throw new IOException("无法读取应用版本",e);}
        currentVersion=info.versionCode;currentVersionName=info.versionName==null?"":info.versionName;
        return new FullBackup(new File(c.getApplicationInfo().dataDir).toPath(),new File(c.getNoBackupFilesDir(),"full-backup").toPath(),c.getPackageName(),System.getProperty("os.arch"),info.versionCode,currentVersionName);
    }
    static boolean active(){return active;}
    static boolean maintenance(){return maintenance||BackupApplication.recoveryError!=null;}
    static boolean awaiting(){return active&&phase.equals("awaiting-confirmation");}
    static boolean restartRequired(){return restartRequired;}
    static String snapshot(){
        try{return new JSONObject().put("active",active).put("phase",phase).put("operation",operation).put("done",done).put("total",total).put("path",path).put("message",active&&CANCEL.get()?"正在取消，等待当前读写结束并清理临时数据…":message)
            .put("canCancel",!CANCEL.get()&&active&&!phase.equals("applying")&&!phase.equals("cleaning"))
            .put("estimated",estimated).put("available",available).put("reserve",spaceReserve).put("restartRequired",restartRequired).put("created",verified==null?0:verified.created).put("version",verified==null?0:verified.appVersion)
            .put("versionName",verified==null?"":verified.appVersionName).put("currentVersion",currentVersion).put("currentVersionName",currentVersionName)
            .put("entries",verified==null?0:verified.entries.size()).toString();}catch(Exception e){return "{}";}
    }
    static String phaseLabel(String p){
        switch(p){
            case "preparing":return "正在暂停网关并保存状态…";
            case "scanning":return "正在扫描备份内容…";
            case "packing":return "正在导出完整备份…";
            case "validating":return "正在导入并校验备份文件…";
            case "verifying":return "正在回读校验已导出的备份…";
            case "rechecking":return "正在复核暂存文件…";
            case "applying":return "正在替换当前数据，请勿关闭应用…";
            case "cleaning":return "正在清理临时数据…";
            case "awaiting-confirmation":return "备份校验通过，等待覆盖确认";
            case "done":return "完整备份导出并校验完成";
            case "restored":return "完整备份已恢复，请重启应用";
            case "cancelled":return "已取消，当前数据未被覆盖";
            default:return p;
        }
    }
    private static synchronized void set(String p,long d,long t,String name){
        phase=p;done=d;total=t;path=name;message=phaseLabel(p);updated=android.os.SystemClock.elapsedRealtime();
    }
    private static void progress(String p,long d,long t,String name){
        if(p.equals("capacity")){estimated=d;available=t;try{spaceReserve=Long.parseLong(name);}catch(Exception ignored){}return;}
        long now=android.os.SystemClock.elapsedRealtime();
        if(!p.equals(phase)||now-updated>=120||d==t)set(p,d,t,name);
    }
    private static synchronized boolean begin(Context c,String op){
        if(active||restartRequired)return false;
        estimated=0;available=-1;spaceReserve=0;ctx=c.getApplicationContext();operation=op;verified=null;CANCEL.set(false);active=true;maintenance=false;set("preparing",0,0,"");
        PowerManager pm=ctx.getSystemService(PowerManager.class);wake=pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"cccodroid:backup");wake.setReferenceCounted(false);wake.acquire();
        return true;
    }
    private static void release(){PowerManager.WakeLock w=wake;wake=null;if(w!=null&&w.isHeld())w.release();}
    private static void quiesce()throws Exception{
        if(Updater.get(ctx).backupBusy()||ShizukuSetup.get(ctx).backupBusy())throw new IOException("工具包或应用正在更新，请完成后再备份或导入");
        maintenance=true;Updater.get(ctx).stopLoop();Notify.get(ctx).stop();
        GatewayService.pause(true,"正在处理完整备份…");
        // A preparing supervisor may have been between its checks and publication.
        GatewayService.pause(true,"正在处理完整备份…");
        GatewayService.stopOwnedForBackup(ctx);
        if(Env.portBusy())throw new IOException("网关尚未完全停止，未修改任何数据，请稍后重试");
        // Native preferences may have outstanding apply() writes; commit is a barrier.
        File prefs=new File(ctx.getApplicationInfo().dataDir,"shared_prefs");File[] list=prefs.listFiles();
        for(File f:list==null?new File[0]:list)if(f.getName().endsWith(".xml"))ctx.getSharedPreferences(f.getName().substring(0,f.getName().length()-4),Context.MODE_PRIVATE).edit().commit();
    }
    private static void resume(){
        maintenance=false;GatewayService.pause(false);
        if(ctx!=null){Notify.get(ctx).start();Updater.get(ctx).loop();if(new Env(ctx).devkitReady())GatewayService.start(ctx);}
    }
    private static void finish(String p,String why){
        phase=p;message=why==null?phaseLabel(p):why;active=false;verified=null;release();
    }
    static boolean export(Context c,Uri uri,String uiJson){
        if(!begin(c,"export"))return false;
        WORK.execute(()->{
            boolean outputStarted=false;
            try{
                FullBackup b=engine(ctx);b.cleanup(FullBackupController::progress,CANCEL::get);
                quiesce();FullBackup.check(CANCEL::get);
                saveUi(ctx,uiJson);
                FullBackup.Manifest m=b.scan(currentVersion,currentVersionName,FullBackupController::progress,CANCEL::get);
                try(android.os.ParcelFileDescriptor pfd=ctx.getContentResolver().openFileDescriptor(uri,"rw")){
                    if(pfd==null)throw new IOException("无法写入所选位置");
                    String real=android.system.Os.readlink("/proc/self/fd/"+pfd.getFd());
                    String data=new File(ctx.getApplicationInfo().dataDir).getCanonicalPath();
                    if(real.equals(data)||real.startsWith(data+"/"))throw new IOException("请将备份保存到应用私有目录之外，避免递归备份");
                    String authority=uri.getAuthority();
                    boolean localProvider="com.android.externalstorage.documents".equals(authority)||"com.android.providers.downloads.documents".equals(authority)||"com.android.providers.media.documents".equals(authority);
                    boolean localPath=real.startsWith("/storage/")||real.startsWith("/sdcard/")||real.startsWith("/mnt/media_rw/")||real.startsWith("/mnt/user/")||real.startsWith("/mnt/pass_through/")||real.startsWith("/data/media/");
                    if(!localProvider&&!localPath)throw new IOException("所选提供方无法保证目标容量信息可靠，请选择本机、SD 卡或 USB 存储；本次未写入备份内容");
                    SpaceGuard space=new SpaceGuard(pfd.getFileDescriptor(),BackupSpace.estimate(m));
                    space.preflight();
                    outputStarted=true;android.system.Os.ftruncate(pfd.getFileDescriptor(),0);
                    android.system.Os.lseek(pfd.getFileDescriptor(),0,android.system.OsConstants.SEEK_SET);
                    try(OutputStream out=new android.os.ParcelFileDescriptor.AutoCloseOutputStream(pfd)){
                        b.exportTo(space.wrap(out),m,FullBackupController::progress,CANCEL::get);
                    }
                }
                set("verifying",0,m.total,"");
                try(InputStream in=ctx.getContentResolver().openInputStream(uri)){
                    if(in==null)throw new IOException("无法回读备份进行校验");
                    b.verify(in,false,FullBackupController::progress,CANCEL::get);
                }
                finish("done",null);
            }catch(Exception e){
                if(outputStarted)try{android.provider.DocumentsContract.deleteDocument(ctx.getContentResolver(),uri);}catch(Exception ignored){}
                finish(e instanceof FullBackup.Cancelled?"cancelled":"error",e instanceof FullBackup.Cancelled?null:"导出失败："+e.getMessage()+(outputStarted?"；未完成的文件不可用于恢复":"；未写入备份内容"));
            }finally{resume();}
        });return true;
    }
    static boolean importFile(Context c,Uri uri){
        if(!begin(c,"import"))return false;
        WORK.execute(()->{
            try{
                FullBackup b=engine(ctx);b.cleanup(FullBackupController::progress,CANCEL::get);
                set("validating",0,0,"");
                try(InputStream in=ctx.getContentResolver().openInputStream(uri)){
                    if(in==null)throw new IOException("无法读取所选备份");
                    verified=b.verify(in,true,FullBackupController::progress,CANCEL::get);
                }
                FullBackup.check(CANCEL::get);
                set("awaiting-confirmation",verified.total,verified.total,"");
                release(); // The user may leave this confirmation pending for a long time.
            }catch(Exception e){
                try{engine(ctx).cleanup(FullBackup.QUIET,FullBackup.NEVER);}catch(Exception ignored){}
                finish(e instanceof FullBackup.Cancelled?"cancelled":"error",e instanceof FullBackup.Cancelled?null:"导入校验失败："+e.getMessage()+"；当前数据未被覆盖");
            }
        });return true;
    }
    /** Only called by the native countdown dialog's positive action. */
    static synchronized void approveImport(){
        if(!awaiting()||verified==null)return;
        FullBackup.Manifest m=verified;set("preparing",0,0,"");
        PowerManager pm=ctx.getSystemService(PowerManager.class);wake=pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"cccodroid:restore");wake.setReferenceCounted(false);wake.acquire();
        WORK.execute(()->{
            boolean committed=false;
            try{
                FullBackup b=engine(ctx);quiesce();
                // Cancellation remains safe until the durable transaction is about to start.
                b.checkStaged(m,FullBackupController::progress,CANCEL::get);FullBackup.check(CANCEL::get);
                set("applying",0,0,"");
                b.commit(m,FullBackupController::progress,null);committed=true;restartRequired=true;
                File tmp=new File(ctx.getFilesDir(),"usr/tmp");if(!tmp.isDirectory()&&!tmp.mkdirs())throw new IOException("创建工具临时目录失败");
                markRestoredUi(ctx);
                set("cleaning",0,0,"");b.cleanup(FullBackupController::progress,FullBackup.NEVER);
                finish("restored",null);
            }catch(Exception e){
                if(committed){restartRequired=true;finish("restored","备份已恢复；清理尚未完成："+e.getMessage()+"。请重启应用，旧环境清理可在下次备份前继续");}
                else{
                    try{engine(ctx).recover();engine(ctx).cleanup(FullBackup.QUIET,FullBackup.NEVER);}
                    catch(Exception recovery){BackupApplication.recoveryError="恢复回滚失败："+recovery.getMessage();restartRequired=true;}
                    boolean cancelled=e instanceof FullBackup.Cancelled&&!restartRequired;
                    finish(cancelled?"cancelled":"error",cancelled?null:"导入失败："+e.getMessage()+(restartRequired?"；需要重启后恢复事务":"；已保留原数据"));
                }
            }finally{if(!restartRequired)resume();}
        });
    }
    static synchronized void cancel(){
        if(!active||phase.equals("applying")||phase.equals("cleaning"))return;
        CANCEL.set(true);
        if(awaiting()){
            set("cleaning",0,0,"");
            WORK.execute(()->{try{engine(ctx).cleanup(FullBackup.QUIET,FullBackup.NEVER);finish("cancelled",null);}catch(Exception e){finish("error","临时文件清理失败："+e.getMessage()+"；当前数据未被覆盖");}});
        }
    }
    private static final class SpaceGuard {
        final FileDescriptor fd;final BackupSpace.Monitor monitor;
        SpaceGuard(FileDescriptor fd,long estimate){
            this.fd=fd;this.monitor=new BackupSpace.Monitor(estimate,()->{
                android.system.StructStatVfs s=stat();return new long[]{multiply(s.f_bavail,s.f_frsize),multiply(s.f_blocks,s.f_frsize)};
            });
        }
        private android.system.StructStatVfs stat()throws IOException{
            try{
                android.system.StructStatVfs s=android.system.Os.fstatvfs(fd);
                if(s.f_frsize<=0||s.f_blocks<=0||s.f_bavail<0)throw new IOException("无法可靠获取所选备份位置的剩余空间");
                return s;
            }catch(android.system.ErrnoException e){throw new IOException("无法查询所选位置的容量，请选择本机、SD 卡或 USB 存储",e);}
        }
        private long multiply(long a,long b)throws IOException{if(a<0||b<=0||a>Long.MAX_VALUE/b)throw new IOException("存储容量数据无效");return a*b;}
        void preflight()throws IOException{
            estimated=monitor.estimated;try{monitor.preflight();}finally{available=monitor.available;spaceReserve=monitor.reserve;}
        }
        OutputStream wrap(OutputStream out){return new FilterOutputStream(out){
            @Override public void write(int b)throws IOException{byte[] one={(byte)b};write(one,0,1);}
            @Override public void write(byte[] b,int off,int n)throws IOException{
                try{monitor.beforeWrite(n,android.os.SystemClock.elapsedRealtime());}finally{available=monitor.available;}
                out.write(b,off,n);
            }
        };}
    }
    private static void saveUi(Context c,String json)throws Exception{
        if(json==null||json.length()>8*1024*1024)throw new IOException("界面状态太大，无法完整备份");
        JSONObject values=new JSONObject(json);
        for(java.util.Iterator<String> it=values.keys();it.hasNext();){String k=it.next();if(!k.startsWith("cc.")&&!k.startsWith("ccapp."))it.remove();}
        Path dir=new File(c.getFilesDir(),"home").toPath();
        if(Files.isSymbolicLink(dir))throw new IOException("home 目录不能是符号链接");
        Files.createDirectories(dir);
        Path tmp=Files.createTempFile(dir,".backup-ui-",".tmp");
        try{
            try(java.nio.channels.FileChannel out=java.nio.channels.FileChannel.open(tmp,StandardOpenOption.WRITE,java.nio.file.LinkOption.NOFOLLOW_LINKS)){
                java.nio.ByteBuffer bytes=java.nio.ByteBuffer.wrap(values.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
                while(bytes.hasRemaining())out.write(bytes);out.force(true);
            }
            Files.move(tmp,dir.resolve(".full-backup-ui.json"),StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);
        }finally{Files.deleteIfExists(tmp);}
    }
    static void markRestoredUi(Context c)throws IOException{
        File ready=new File(c.getNoBackupFilesDir(),"full-backup/ui-ready");
        if(ready.exists())return;
        new File(c.getFilesDir(),".backup-ui-pending").createNewFile();
        ready.getParentFile().mkdirs();ready.createNewFile();
    }
    static String takeUi(Context c){
        File flag=new File(c.getFilesDir(),".backup-ui-pending");
        if(!flag.exists())return "";
        try{
            File f=new File(c.getFilesDir(),"home/.full-backup-ui.json");if(!Files.isRegularFile(f.toPath(),LinkOption.NOFOLLOW_LINKS))throw new IOException("界面状态不是普通文件");if(f.length()>8*1024*1024)throw new IOException("界面状态过大");
            String json=new String(Files.readAllBytes(f.toPath()),java.nio.charset.StandardCharsets.UTF_8);new JSONObject(json);
            flag.delete();return json;
        }catch(Exception e){flag.delete();return "{}";}
    }
}
