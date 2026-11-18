package cc.codroid;
/** A short-lived second process relaunches the app after preference/database replacement. */
public final class BackupRestartActivity extends android.app.Activity {
    @Override protected void onCreate(android.os.Bundle state){
        super.onCreate(state);
        int pid=getIntent().getIntExtra("previousPid",-1);
        try{
            if(pid<=0||pid==android.os.Process.myPid()||android.system.Os.stat("/proc/"+pid).st_uid!=android.os.Process.myUid()){finish();return;}
            android.os.Process.killProcess(pid);
            android.content.Intent main=getPackageManager().getLaunchIntentForPackage(getPackageName());
            if(main!=null)startActivity(main.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK|android.content.Intent.FLAG_ACTIVITY_CLEAR_TASK));
        }catch(Exception e){android.util.Log.e("cccodroid-backup","重新启动失败，请从桌面打开应用",e);}
        finally{finish();android.os.Process.killProcess(android.os.Process.myPid());}
    }
}
