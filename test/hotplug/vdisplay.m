// 시험용 가상 모니터 — «HDMI 꽂기·빼기»를 흉내 낸다.
// 실행하면 가상 모니터가 하나 생기고(꽂기), 프로세스가 끝나면 사라진다(빼기).
// 같은 --serial 로 다시 실행하면 macOS 는 같은 모니터를 다시 꽂은 것으로 본다.
// 사용: vdisplay [--seconds N] [--serial N] [--id-file 경로]
// macOS 의 비공개 API(CGVirtualDisplay)를 쓴다. 시험 전용이며 앱 본체는 쓰지 않는다.
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>

@interface CGVirtualDisplayDescriptor : NSObject
@property (retain, nonatomic) dispatch_queue_t queue;
@property (retain, nonatomic) NSString *name;
@property (nonatomic) unsigned int maxPixelsWide;
@property (nonatomic) unsigned int maxPixelsHigh;
@property (nonatomic) CGSize sizeInMillimeters;
@property (nonatomic) unsigned int productID;
@property (nonatomic) unsigned int vendorID;
@property (nonatomic) unsigned int serialNum;
@property (copy, nonatomic) void (^terminationHandler)(id, id);
@end
@interface CGVirtualDisplayMode : NSObject
- (instancetype)initWithWidth:(unsigned int)w height:(unsigned int)h refreshRate:(double)r;
@end
@interface CGVirtualDisplaySettings : NSObject
@property (retain, nonatomic) NSArray *modes;
@property (nonatomic) unsigned int hiDPI;
@end
@interface CGVirtualDisplay : NSObject
- (instancetype)initWithDescriptor:(CGVirtualDisplayDescriptor *)d;
- (BOOL)applySettings:(CGVirtualDisplaySettings *)s;
@property (readonly, nonatomic) unsigned int displayID;
@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    double seconds = 30; unsigned int serial = 4242; NSString *idFile = nil;
    for (int i = 1; i < argc; i++) {
      if (!strcmp(argv[i], "--seconds") && i + 1 < argc) seconds = atof(argv[++i]);
      else if (!strcmp(argv[i], "--serial") && i + 1 < argc) serial = (unsigned)atoi(argv[++i]);
      else if (!strcmp(argv[i], "--id-file") && i + 1 < argc) idFile = [NSString stringWithUTF8String:argv[++i]];
    }
    CGVirtualDisplayDescriptor *d = [CGVirtualDisplayDescriptor new];
    d.queue = dispatch_get_main_queue();
    d.name = @"MacRecorder Test Display";
    d.maxPixelsWide = 1920; d.maxPixelsHigh = 1080;
    d.sizeInMillimeters = CGSizeMake(530, 300);
    d.vendorID = 0xEEEE; d.productID = 0x1234; d.serialNum = serial;
    CGVirtualDisplay *vd = [[CGVirtualDisplay alloc] initWithDescriptor:d];
    if (!vd) { fprintf(stderr, "가상 모니터를 만들지 못했습니다\n"); return 1; }
    CGVirtualDisplaySettings *s = [CGVirtualDisplaySettings new];
    s.hiDPI = 0;
    s.modes = @[[[CGVirtualDisplayMode alloc] initWithWidth:1920 height:1080 refreshRate:60]];
    if (![vd applySettings:s]) { fprintf(stderr, "설정 적용 실패\n"); return 1; }
    printf("%u\n", vd.displayID); fflush(stdout);
    if (idFile) [[NSString stringWithFormat:@"%u", vd.displayID] writeToFile:idFile atomically:YES encoding:NSUTF8StringEncoding error:nil];
    dispatch_source_t sig = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGTERM, 0, dispatch_get_main_queue());
    signal(SIGTERM, SIG_IGN);
    dispatch_source_set_event_handler(sig, ^{ exit(0); });
    dispatch_resume(sig);
    [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:seconds]];
    (void)vd;
  }
  return 0;
}
