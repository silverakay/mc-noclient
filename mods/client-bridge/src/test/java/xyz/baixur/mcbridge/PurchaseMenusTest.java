package xyz.baixur.mcbridge;

public final class PurchaseMenusTest {
    private static void check(boolean value) { if (!value) throw new AssertionError("Unsafe purchase navigation"); }
    public static void main(String[] args) {
        check(PurchaseMenus.allowedName("系统商店", "系统收购"));
        check(PurchaseMenus.allowedName("系统商店", "星露谷收购"));
        check(PurchaseMenus.allowedName("星露谷收购商店", "农作物收购"));
        for (String name : new String[] {"系统收购", "星露谷收购", "农作物收购", "小镇商店", "黑曜石", "钓鱼收购"}) {
            check(!PurchaseMenus.allowedName("每日随机收购商店", name));
            check(!PurchaseMenus.allowedName("星露谷每日随机收购商店", name));
            check(!PurchaseMenus.allowedName("鱼店收购-请放入特殊鱼", name));
        }
        check(PurchaseMenus.clean("§6农作物收购").equals("农作物收购"));
        check(PurchaseMenus.allowedName("《芒果小镇主菜单》", "小镇商店"));
        check(!PurchaseMenus.allowedName("《芒果小镇主菜单》", "公会功能"));
        check(!PurchaseMenus.allowedName("公会功能菜单", "小镇商店"));
        check(!PurchaseMenus.allowedName("星露谷收购商店", "钓鱼收购"));
        check(!PurchaseMenus.allowedName("每日随机收购商店", "系统收购"));
        System.out.println("PASS PurchaseMenus: navigation whitelist excludes every sellable slot and fish; no game/network");
    }
}
