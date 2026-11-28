//go:build darwin && cgo

package environment

/*
#cgo LDFLAGS: -framework Security -framework CoreFoundation
#include <Security/Security.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdlib.h>
#include <string.h>

static CFMutableDictionaryRef query(const char *service, const char *account) {
    CFStringRef s = CFStringCreateWithCString(NULL, service, kCFStringEncodingUTF8);
    CFStringRef a = CFStringCreateWithCString(NULL, account, kCFStringEncodingUTF8);
    if (!s || !a) { if(s) CFRelease(s); if(a) CFRelease(a); return NULL; }
    CFMutableDictionaryRef q = CFDictionaryCreateMutable(NULL, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    if (q) {
        CFDictionarySetValue(q, kSecClass, kSecClassGenericPassword);
        CFDictionarySetValue(q, kSecAttrService, s);
        CFDictionarySetValue(q, kSecAttrAccount, a);
        CFDictionarySetValue(q, kSecAttrSynchronizable, kCFBooleanFalse);
    }
    CFRelease(s); CFRelease(a); return q;
}
static OSStatus nx_put(const char *s, const char *a, const void *data, size_t n) {
    CFMutableDictionaryRef q = query(s,a);
    if(!q) return errSecAllocate;
    CFDataRef d = CFDataCreate(NULL,data,(CFIndex)n);
    if(!d) { CFRelease(q); return errSecAllocate; }
    CFDictionarySetValue(q,kSecValueData,d);
    OSStatus status = SecItemAdd(q,NULL);
    CFRelease(d); CFRelease(q); return status;
}
static OSStatus nx_get(const char *s, const char *a, CFDataRef *out) {
    CFMutableDictionaryRef q=query(s,a);
    if(!q) return errSecAllocate;
    CFDictionarySetValue(q,kSecReturnData,kCFBooleanTrue);
    CFDictionarySetValue(q,kSecMatchLimit,kSecMatchLimitOne);
    CFTypeRef result=NULL;
    OSStatus status=SecItemCopyMatching(q,&result);
    CFRelease(q);
    if(status==errSecSuccess) {
        if (!result || CFGetTypeID(result)!=CFDataGetTypeID()) { if(result) CFRelease(result); return errSecDecode; }
        *out=(CFDataRef)result;
    }
    return status;
}
static OSStatus nx_del(const char *s, const char *a) {
    CFMutableDictionaryRef q=query(s,a);
    if(!q) return errSecAllocate;
    OSStatus status=SecItemDelete(q); CFRelease(q); return status;
}
static void nx_clear_free(void *p,size_t n){if(p){memset_s(p,n,0,n);free(p);}}
*/
import "C"
import (
	"errors"
	"unsafe"
)

func nativePut(namespace, ref string, data []byte) error {
	service := C.CString(namespace + ".ssh")
	account := C.CString(ref)
	defer C.free(unsafe.Pointer(service))
	defer C.free(unsafe.Pointer(account))
	value := C.CBytes(data)
	defer C.nx_clear_free(value, C.size_t(len(data)))
	if C.nx_put(service, account, value, C.size_t(len(data))) != C.errSecSuccess {
		return errors.New("Keychain credential write failed")
	}
	return nil
}
func nativeGet(namespace, ref string) ([]byte, error) {
	service := C.CString(namespace + ".ssh")
	account := C.CString(ref)
	defer C.free(unsafe.Pointer(service))
	defer C.free(unsafe.Pointer(account))
	var data C.CFDataRef
	if C.nx_get(service, account, &data) != C.errSecSuccess {
		return nil, ErrCredentialMissing
	}
	defer C.CFRelease(C.CFTypeRef(data))
	n := C.CFDataGetLength(data)
	if n < 1 || n > 16*1024 {
		return nil, ErrCredentialMissing
	}
	return C.GoBytes(unsafe.Pointer(C.CFDataGetBytePtr(data)), C.int(n)), nil
}
func nativeDelete(namespace, ref string) error {
	service := C.CString(namespace + ".ssh")
	account := C.CString(ref)
	defer C.free(unsafe.Pointer(service))
	defer C.free(unsafe.Pointer(account))
	status := C.nx_del(service, account)
	if status != C.errSecSuccess && status != C.errSecItemNotFound {
		return errors.New("Keychain credential removal failed")
	}
	return nil
}
