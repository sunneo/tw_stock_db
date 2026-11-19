; GTK3 視窗：標籤、輸入框、按鈕、勾選框（widget）。按鈕每按一次，標籤顯示「第 N 次，輸入框：…」。
; 命令列第一個參數 N（測試用）：程式自己按 N 次按鈕後 200 ms 離開；沒給就一直跑到關視窗。
; 建置：見 ../README.md（連結旗標用 pkg-config --libs gtk+-3.0）。
target triple = "x86_64-pc-linux-gnu"

@title = private constant [14 x i8] c"IR GTK3 demo\00\00"
@hello = private constant [21 x i8] c"Press the button...\0A\00"
@btn = private constant [9 x i8] c"Count++\00\00"
@chk = private constant [12 x i8] c"Show text\00\00\00"
@sig_clicked = private constant [8 x i8] c"clicked\00"
@sig_destroy = private constant [8 x i8] c"destroy\00"
@fmt = private constant [28 x i8] c"Pressed %d times, entry: %s\00"
@fmt2 = private constant [12 x i8] c"count=%d\0A\00\00\00"
@lbl0 = private constant [18 x i8] c"Not pressed yet.\00\00"

@count = internal global i32 0
@label = internal global ptr null
@entry = internal global ptr null
@button = internal global ptr null
@check = internal global ptr null

declare void @gtk_init(ptr, ptr)
declare ptr @gtk_window_new(i32)
declare void @gtk_window_set_title(ptr, ptr)
declare void @gtk_window_set_default_size(ptr, i32, i32)
declare ptr @gtk_box_new(i32, i32)
declare ptr @gtk_label_new(ptr)
declare void @gtk_label_set_text(ptr, ptr)
declare ptr @gtk_entry_new()
declare ptr @gtk_entry_get_text(ptr)
declare ptr @gtk_button_new_with_label(ptr)
declare ptr @gtk_check_button_new_with_label(ptr)
declare i32 @gtk_toggle_button_get_active(ptr)
declare void @gtk_button_clicked(ptr)
declare void @gtk_container_add(ptr, ptr)
declare void @gtk_container_set_border_width(ptr, i32)
declare void @gtk_box_pack_start(ptr, ptr, i32, i32, i32)
declare void @gtk_widget_show_all(ptr)
declare void @gtk_main()
declare void @gtk_main_quit()
declare i64 @g_signal_connect_data(ptr, ptr, ptr, ptr, ptr, i32)
declare i32 @g_timeout_add(i32, ptr, ptr)
declare i32 @atoi(ptr)
declare i32 @snprintf(ptr, i64, ptr, ...)
declare i32 @printf(ptr, ...)

define void @on_click(ptr %w, ptr %data) {
  %c = load i32, ptr @count
  %c1 = add i32 %c, 1
  store i32 %c1, ptr @count
  %e = load ptr, ptr @entry
  %t = call ptr @gtk_entry_get_text(ptr %e)
  %k = load ptr, ptr @check
  %on = call i32 @gtk_toggle_button_get_active(ptr %k)
  %buf = alloca [160 x i8]
  %shown = icmp ne i32 %on, 0
  %txt = select i1 %shown, ptr %t, ptr @lbl0
  call i32 (ptr, i64, ptr, ...) @snprintf(ptr %buf, i64 160, ptr @fmt, i32 %c1, ptr %txt)
  %l = load ptr, ptr @label
  call void @gtk_label_set_text(ptr %l, ptr %buf)
  ret void
}

define void @on_destroy(ptr %w, ptr %data) {
  call void @gtk_main_quit()
  ret void
}

define i32 @quit_cb(ptr %data) {
  %c = load i32, ptr @count
  call i32 (ptr, ...) @printf(ptr @fmt2, i32 %c)
  call void @gtk_main_quit()
  ret i32 0
}

define i32 @main(i32 %argc, ptr %argv) {
  call void @gtk_init(ptr null, ptr null)
  %win = call ptr @gtk_window_new(i32 0)
  call void @gtk_window_set_title(ptr %win, ptr @title)
  call void @gtk_window_set_default_size(ptr %win, i32 320, i32 160)
  call void @gtk_container_set_border_width(ptr %win, i32 12)
  %box = call ptr @gtk_box_new(i32 1, i32 8)
  call void @gtk_container_add(ptr %win, ptr %box)
  %lab = call ptr @gtk_label_new(ptr @lbl0)
  store ptr %lab, ptr @label
  %ent = call ptr @gtk_entry_new()
  store ptr %ent, ptr @entry
  %ck = call ptr @gtk_check_button_new_with_label(ptr @chk)
  store ptr %ck, ptr @check
  %bt = call ptr @gtk_button_new_with_label(ptr @btn)
  store ptr %bt, ptr @button
  call void @gtk_box_pack_start(ptr %box, ptr %lab, i32 1, i32 1, i32 0)
  call void @gtk_box_pack_start(ptr %box, ptr %ent, i32 0, i32 0, i32 0)
  call void @gtk_box_pack_start(ptr %box, ptr %ck, i32 0, i32 0, i32 0)
  call void @gtk_box_pack_start(ptr %box, ptr %bt, i32 0, i32 0, i32 0)
  call i64 @g_signal_connect_data(ptr %bt, ptr @sig_clicked, ptr @on_click, ptr null, ptr null, i32 0)
  call i64 @g_signal_connect_data(ptr %win, ptr @sig_destroy, ptr @on_destroy, ptr null, ptr null, i32 0)
  call void @gtk_widget_show_all(ptr %win)
  %auto = icmp sgt i32 %argc, 1
  br i1 %auto, label %test, label %run
test:
  %ap = getelementptr ptr, ptr %argv, i32 1
  %a1 = load ptr, ptr %ap
  %n = call i32 @atoi(ptr %a1)
  br label %clicks
clicks:
  %i = phi i32 [ 0, %test ], [ %i1, %click ]
  %more = icmp slt i32 %i, %n
  br i1 %more, label %click, label %arm
click:
  call void @gtk_button_clicked(ptr %bt)
  %i1 = add i32 %i, 1
  br label %clicks
arm:
  call i32 @g_timeout_add(i32 200, ptr @quit_cb, ptr null)
  br label %run
run:
  call void @gtk_main()
  ret i32 0
}
