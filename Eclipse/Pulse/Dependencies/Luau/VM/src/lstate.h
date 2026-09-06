// This file is part of the Luau programming language and is licensed under MIT License; see LICENSE.txt for details
// This code is based on Lua 5.x implementation licensed under MIT License; see lua_LICENSE.txt for details
#pragma once

#include "lobject.h"
#include "ltm.h"
#include "ludata.h"

// registry
#define registry(L) (&L->global->registry)

// extra stack space to handle TM calls and some other extras
#define EXTRA_STACK 5

#define BASIC_CI_SIZE 8

#define BASIC_STACK_SIZE (2 * LUA_MINSTACK)

// clang-format off
typedef struct stringtable
{
    TString** hash; // 0x0
    uint32_t nuse; // 0x8
    int size; // 0xC
} stringtable;
// clang-format on

/*
** informations about a call
**
** the general Lua stack frame structure is as follows:
** - each function gets a stack frame, with function "registers" being stack slots on the frame
** - function arguments are associated with registers 0+
** - function locals and temporaries follow after; usually locals are a consecutive block per scope, and temporaries are allocated after this, but
*this is up to the compiler
**
** when function doesn't have varargs, the stack layout is as follows:
** ^ (func) ^^ [fixed args] [locals + temporaries]
** where ^ is the 'func' pointer in CallInfo struct, and ^^ is the 'base' pointer (which is what registers are relative to)
**
** when function *does* have varargs, the stack layout is more complex - the runtime has to copy the fixed arguments so that the 0+ addressing still
*works as follows:
** ^ (func) [fixed args] [varargs] ^^ [fixed args] [locals + temporaries]
**
** computing the sizes of these individual blocks works as follows:
** - the number of fixed args is always matching the `numparams` in a function's Proto object; runtime adds `nil` during the call execution as
*necessary
** - the number of variadic args can be computed by evaluating (ci->base - ci->func - 1 - numparams)
**
** the CallInfo structures are allocated as an array, with each subsequent call being *appended* to this array (so if f calls g, CallInfo for g
*immediately follows CallInfo for f)
** the `nresults` field in CallInfo is set by the caller to tell the function how many arguments the caller is expecting on the stack after the
*function returns
** the `flags` field in CallInfo contains internal execution flags that are important for pcall/etc, see LUA_CALLINFO_*
*/
// clang-format off
typedef struct CallInfo
{
    const Instruction* savedpc; // 0x0
    StkId func; // 0x8
    StkId top; // 0x10
    StkId base; // 0x18
    int nresults; // 0x20
    unsigned int flags; // 0x24
} CallInfo;
// clang-format on

#define LUA_CALLINFO_RETURN (1 << 0) // should the interpreter return after returning from this callinfo? first frame must have this set
#define LUA_CALLINFO_HANDLE (1 << 1) // should the error thrown during execution get handled by continuation from this callinfo? func must be C
#define LUA_CALLINFO_NATIVE (1 << 2) // should this function be executed using execution callback for native code
#define LUA_CALLINFO_OPYIELD (1 << 3) // call frame has yielded on a non-call opcode and requires luaV_finishop

#define curr_func(L) (clvalue(L->ci->func))
#define ci_func(ci) (clvalue((ci)->func))
#define f_isLua(ci) (!ci_func(ci)->isC)
#define isLua(ci) (ttisfunction((ci)->func) && f_isLua(ci))

struct GCStats
{
    // data for proportional-integral controller of heap trigger value
    int32_t triggerterms[32] = {0};
    uint32_t triggertermpos = 0;
    int32_t triggerintegral = 0;

    size_t atomicstarttotalsizebytes = 0;
    size_t endtotalsizebytes = 0;
    size_t heapgoalsizebytes = 0;

    double starttimestamp = 0;
    double atomicstarttimestamp = 0;
    double endtimestamp = 0;
};

#ifdef LUAI_GCMETRICS
struct GCCycleMetrics
{
    size_t starttotalsizebytes = 0;
    size_t heaptriggersizebytes = 0;

    double pausetime = 0.0; // time from end of the last cycle to the start of a new one

    double starttimestamp = 0.0;
    double endtimestamp = 0.0;

    double marktime = 0.0;
    double markassisttime = 0.0;
    double markmaxexplicittime = 0.0;
    size_t markexplicitsteps = 0;
    size_t markwork = 0;

    double atomicstarttimestamp = 0.0;
    size_t atomicstarttotalsizebytes = 0;
    double atomictime = 0.0;

    // specific atomic stage parts
    double atomictimeupval = 0.0;
    double atomictimeweak = 0.0;
    double atomictimegray = 0.0;
    double atomictimeclear = 0.0;

    double sweeptime = 0.0;
    double sweepassisttime = 0.0;
    double sweepmaxexplicittime = 0.0;
    size_t sweepexplicitsteps = 0;
    size_t sweepwork = 0;

    size_t assistwork = 0;
    size_t explicitwork = 0;

    size_t propagatework = 0;
    size_t propagateagainwork = 0;

    size_t endtotalsizebytes = 0;
};

struct GCMetrics
{
    double stepexplicittimeacc = 0.0;
    double stepassisttimeacc = 0.0;

    // when cycle is completed, last cycle values are updated
    uint64_t completedcycles = 0;

    GCCycleMetrics lastcycle;
    GCCycleMetrics currcycle;
};
#endif

// Callbacks that can be used to to redirect code execution from Luau bytecode VM to a custom implementation (AoT/JiT/sandboxing/...)
struct lua_ExecutionCallbacks
{
    void* context;
    void (*close)(lua_State* L);                 // called when global VM state is closed
    void (*destroy)(lua_State* L, Proto* proto); // called when function is destroyed
    int (*enter)(lua_State* L, Proto* proto);    // called when function is about to start/resume (when execdata is present), return 0 to exit VM
    void (*disable)(lua_State* L, Proto* proto); // called when function has to be switched from native to bytecode in the debugger
    size_t (*getmemorysize)(lua_State* L, Proto* proto); // called to request the size of memory associated with native part of the Proto
    uint8_t (*gettypemapping)(lua_State* L, const char* str, size_t len); // called to get the userdata type index
    char* (*getcounterdata)(
        lua_State* L,
        Proto* proto,
        size_t* count
    ); // called to get the execution counter data and count {uint32_t, uint32_t, uint64_t}
    Proto* (*inlinefunction)(lua_State* L, Closure* caller, Closure* target, uint32_t pc); // called when inlining threshold is reached
};

struct lua_UdataDirectAccessData
{
    TValue indextm;
    TValue newindextm;
    TValue namecalltm;
    lua_UserdataDirectAccess index;
    lua_UserdataDirectAccess newindex;
    lua_UserdataDirectNamecall namecall;
};

/*
** `global state', shared by all threads of this state
*/
// clang-format off
// Real dump for this build (Downloads/message(1).txt, applied verbatim
// including explicit _padN gap fields exactly as supplied -- this is the
// first pass where global_State itself was actually dumped, not carried
// over from an old vendored snapshot or approximated from upstream
// master). frealloc/ud (what luaM_newgco reads first, on every single GC
// allocation -- lua_newthread, lua_newtable, every string/closure) are
// now at 0x28/0x30, replacing the two different wrong guesses from
// before this pass.
typedef struct global_State
{
    stringtable strt;                                // 0x0000 (0)
    GCObject* gray;                                  // 0x0010 (16)
    GCObject* grayagain;                             // 0x0018 (24)
    GCObject* weak;                                  // 0x0020 (32)
    lua_Alloc frealloc;                              // 0x0028 (40)
    void* ud;                                        // 0x0030 (48)
    int gcstepsize;                                  // 0x0038 (56)
    int gcstepmul;                                   // 0x003C (60)
    int gcgoal;                                      // 0x0040 (64)
    char _pad0[0x4];                                 // 0x0044 (68)
    size_t GCthreshold;                              // 0x0048 (72)
    size_t totalbytes;                               // 0x0050 (80)
    uint8_t currentwhite;                            // 0x0058 (88)
    uint8_t gcstate;                                 // 0x0059 (89)
    char _pad1[0x6];                                 // 0x005A (90)
    struct lua_Page* freepages[LUA_SIZECLASSES];     // 0x0060 (96)
    struct lua_State* mainthread;                    // 0x01A0 (416)
    struct lua_Page* sweepgcopage;                   // 0x01A8 (424)
    struct lua_Page* freegcopages[LUA_SIZECLASSES];  // 0x01B0 (432)
    struct lua_Page* allgcopages;                    // 0x02F0 (752)
    struct lua_Page* allpages;                       // 0x02F8 (760)
    UpVal uvhead;                                    // 0x0300 (768)
    struct LuaTable* mt[LUA_T_COUNT];                // 0x0328 (808)
    TString* tmname[TM_N];                           // 0x0398 (920)
    TString* ttname[LUA_T_COUNT];                    // 0x0440 (1088)
    TValue pseudotemp;                               // 0x04B0 (1200)
    TValue registry;                                 // 0x04C0 (1216)
    int registryfree;                                // 0x04D0 (1232)
    char _pad2[0x4];                                 // 0x04D4 (1236)
    struct lua_jmpbuf* errorjmp;                     // 0x04D8 (1240)
    lua_Callbacks cb;                                // 0x04E0 (1248)
    uint64_t rngstate;                               // 0x0530 (1328)
    uint64_t ptrenckey[4];                           // 0x0538 (1336)
    lua_ExecutionCallbacks ecb;                      // 0x0558 (1368)
    alignas(16) uint8_t ecbdata[LUA_EXECUTION_CALLBACK_STORAGE]; // 0x05A0 (1440)
    lua_UdataDirectAccessData udatadirect[UTAG_INTERNAL_LIMIT];  // 0x07A0 (1952)
    size_t memcatbytes[LUA_MEMORY_CATEGORIES];       // 0x2C30 (11312)
    void (*udatagc[LUA_UTAG_LIMIT])(lua_State*, void*);   // 0x3430 (13360)
    void (*udatamark[LUA_UTAG_LIMIT])(lua_State*, void*); // 0x3830 (14384)
    LuaTable* udatamt[LUA_UTAG_LIMIT];               // 0x3C30 (15408)
    TValue weakregistry;                             // 0x4030 (16432)
    int weakregistryfree;                            // 0x4040 (16448)
    char _pad3[0x4];                                 // 0x4044 (16452)
    lua_EmbedderGc embeddergc;                        // 0x4048 (16456)
    TString* lightuserdataname[LUA_LUTAG_LIMIT];     // 0x4050 (16464)
    struct LuaTable* udatadirectfields[UTAG_INTERNAL_LIMIT]; // 0x4450 (17488)
    GCStats gcstats;                                 // 0x4850 (18512)
    uint32_t lastprotoid;                            // 0x4918 (18712)
    char _pad4[0x4];                                 // 0x491C (18716)
#ifdef LUAI_GCMETRICS
    GCMetrics gcmetrics;
#endif
} global_State;
// clang-format on

/*
** `per thread' state
*/
// clang-format off
// Layout confirmed against a real dump for client version ddf602d9cfe44005
// (128 bytes total, unchanged size, every field after the first four
// reordered). Every field kept its existing name/type from the prior
// layout -- only positions moved -- so nothing outside this struct
// definition needed to change.
struct lua_State
{
    CommonHeader;
    uint8_t status; // 0x3
    uint8_t activememcat; // 0x4
    bool singlestep; // 0x5
    bool isactive; // 0x6
    StkId top; // 0x8
    StkId stack_last; // 0x10
    CallInfo* ci; // 0x18
    global_State* global; // 0x20
    StkId base; // 0x28
    StkId stack; // 0x30
    TString* namecall; // 0x38
    GCObject* gclist; // 0x40
    UpVal* openupval; // 0x48
    LuaTable* gt; // 0x50
    RobloxExtraSpace* userdata; // 0x58
    CallInfo* end_ci; // 0x60
    CallInfo* base_ci; // 0x68
    unsigned short nCcalls; // 0x70
    unsigned short baseCcalls; // 0x72
    int cachedslot; // 0x74
    LSTATE_STACKSIZE_ENC<int> stacksize; // 0x78
    int size_ci; // 0x7C
};
// clang-format on

/*
** Union of all collectible objects
*/
union GCObject
{
    GCheader gch;
    struct TString ts;
    struct Udata u;
    struct Closure cl;
    struct LuaTable h;
    struct Proto p;
    struct UpVal uv;
    struct lua_State th; // thread
    struct LuauBuffer buf;
    struct LuauClass lclass;
    struct LuauObject lobject;
};

// macros to convert a GCObject into a specific value
#define gco2ts(o) check_exp((o)->gch.tt == LUA_TSTRING, &((o)->ts))
#define gco2u(o) check_exp((o)->gch.tt == LUA_TUSERDATA, &((o)->u))
#define gco2cl(o) check_exp((o)->gch.tt == LUA_TFUNCTION, &((o)->cl))
#define gco2h(o) check_exp((o)->gch.tt == LUA_TTABLE, &((o)->h))
#define gco2p(o) check_exp((o)->gch.tt == LUA_TPROTO, &((o)->p))
#define gco2uv(o) check_exp((o)->gch.tt == LUA_TUPVAL, &((o)->uv))
#define gco2th(o) check_exp((o)->gch.tt == LUA_TTHREAD, &((o)->th))
#define gco2buf(o) check_exp((o)->gch.tt == LUA_TBUFFER, &((o)->buf))
#define gco2class(o) check_exp((o)->gch.tt == LUA_TCLASS, &((o)->lclass))
#define gco2object(o) check_exp((o)->gch.tt == LUA_TOBJECT, &((o)->lobject))

// macro to convert any Lua object into a GCObject
#define obj2gco(v) check_exp(iscollectable(v), cast_to(GCObject*, (v) + 0))

LUAI_FUNC lua_State* luaE_newthread(lua_State* L);
LUAI_FUNC void luaE_freethread(lua_State* L, lua_State* L1, struct lua_Page* page);
