#pragma once

#include <Roblox/EncryptionsHelper.hpp>

// Updated against a real offset/struct dump for client version
// ddf602d9cfe44005 -- every mapping below changed from the previous
// (guessed/stale) build's values. See Roblox/Offsets.hpp for the same
// build's function/singleton addresses.
#define PROTO_LINEINFO_ENC VMValue3
#define PROTO_ABSLINEINFO_ENC VMValue4
#define PROTO_LOCVARS_ENC VMValue1
#define PROTO_UPVALUES_ENC VMValue1
#define PROTO_SOURCE_ENC VMValue1

#define PROTO_DEBUGINSN_ENC VMValue2
#define PROTO_DEBUGNAME_ENC VMValue4
#define PROTO_TYPEINFO_ENC VMValue1
#define PROTO_USERDATA_ENC VMValue4

#define LSTATE_STACKSIZE_ENC VMValue4

#define CLOSURE_CONT_ENC VMValue3
// Closure's debug name is no longer a single encoded field in this build
// -- the struct now carries a plain (unencoded) TString* debugname AND a
// separate, still-encoded debugname_DEPRECATED<const char*>. This macro
// maps to the deprecated field's scheme; the main debugname field is
// written as a plain TString* directly in the struct, not through this
// macro. Nothing in this codebase currently reads either field.
#define CLOSURE_DEBUGNAME_ENC VMValue1

#define UDATA_META_ENC VMValue3

#define TSTRING_HASH_ENC VMValue3