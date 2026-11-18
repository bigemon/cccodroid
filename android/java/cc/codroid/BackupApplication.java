package cc.codroid;
/** Recover directory swaps before any Activity/Service can open preferences or a database. */
public final class BackupApplication extends android.app.Application {
    static volatile String recoveryError;
    @Override public void onCreate(){
        super.onCreate();
        try{if(FullBackupController.engine(this).recover())FullBackupController.markRestoredUi(this);}
        catch(Exception e){recoveryError="完整备份恢复未完成："+e.getMessage();android.util.Log.e("cccodroid-backup","恢复事务失败",e);}
        if(recoveryError==null)MainActivity.warmIntentKey(this);
    }
}
