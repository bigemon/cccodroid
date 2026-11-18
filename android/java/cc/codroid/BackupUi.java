package cc.codroid;

/** Stable progress mapping; counts/bytes come from I/O, never from a timer. */
final class BackupUi {
    static int percent(String op,String phase,long done,long total){
        if(phase.equals("done")||phase.equals("restored"))return 100;
        if(op.equals("import")&&phase.equals("awaiting-confirmation"))return 80;
        if(total<=0)return -1;
        double f=Math.max(0,Math.min(1,(double)done/total));
        if(op.equals("export")){
            if(phase.equals("packing"))return (int)(5+65*f);
            if(phase.equals("verifying"))return (int)(70+29*f);
        }else{
            if(phase.equals("validating"))return (int)(5+75*f);
            if(phase.equals("awaiting-confirmation"))return 80;
            if(phase.equals("rechecking"))return (int)(80+10*f);
            if(phase.equals("applying"))return (int)(90+9*f);
        }
        return -1;
    }
    static String versionLabel(int code,String name){
        return (name==null||name.isEmpty()?"版本名未记录":name)+"（构建 "+code+"）";
    }
    static boolean versionMismatch(int backup,String backupName,int current,String currentName){
        return backup!=current||backupName!=null&&!backupName.isEmpty()&&!backupName.equals(currentName);
    }
    static long importWaitMillis(int backup,String backupName,int current,String currentName){
        return versionMismatch(backup,backupName,current,currentName)||backupName==null||backupName.isEmpty()?15000:10000;
    }
    static String importWarning(int backup,String backupName,int current,String currentName){
        boolean mismatch=versionMismatch(backup,backupName,current,currentName);
        String status=mismatch?"⚠ 版本不一致：跨版本导入可能造成数据丢失、配置不兼容、工具损坏或应用无法正常启动。"
            :backupName==null||backupName.isEmpty()?"⚠ 旧备份未记录版本名，无法完整确认版本一致性；仍可能存在跨版本兼容风险。"
            :"版本一致；完整导入仍是高风险覆盖操作。";
        return "备份版本："+versionLabel(backup,backupName)+"\n当前版本："+versionLabel(current,currentName)+"\n\n"+status
            +"\n\n继续将结束正在执行的任务，以备份内容替换当前内部工作区、会话记录、工具环境、配置和登录凭据。当前新增或修改的内容会丢失，无法与备份合并；工具临时目录也会被清空重建。APK、共享存储中的文件不被替换。"
            +"\n\n备份中的脚本和配置可能在重启后自动执行；完整性校验不代表来源可信。系统权限和高风险授权需要重新确认，成功后必须重启应用。请先导出当前环境留底；完成覆盖后无法通过取消撤销。"
            +"\n\n请阅读上述风险；确认按钮将在连续前台查看 "+(importWaitMillis(backup,backupName,current,currentName)/1000)+" 秒后启用。";
    }
    static String bytes(long n){
        String[] units={"B","KiB","MiB","GiB","TiB"};double value=n;int u=0;
        while(value>=1024&&u<units.length-1){value/=1024;u++;}
        return String.format(java.util.Locale.ROOT,u==0?"%.0f %s":"%.1f %s",value,units[u]);
    }
}
