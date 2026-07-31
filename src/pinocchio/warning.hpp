// Shim for Pinocchio generated header.

#ifndef PINOCCHIO_WARNING_HPP
#define PINOCCHIO_WARNING_HPP

#define PINOCCHIO_WARN_STRINGISE_IMPL(x) #x
#define PINOCCHIO_WARN_STRINGISE(x) PINOCCHIO_WARN_STRINGISE_IMPL(x)

#ifdef __GNUC__
  #define PINOCCHIO_WARN(exp) ("WARNING: " exp)
#elif defined(_MSC_VER)
  #define PINOCCHIO_WARN_FILE_LINE \
    __FILE__ "(" PINOCCHIO_WARN_STRINGISE(__LINE__) ") : "
  #define PINOCCHIO_WARN(exp) (PINOCCHIO_WARN_FILE_LINE "WARNING: " exp)
#else
  #define PINOCCHIO_WARN(exp)
#endif

#endif // PINOCCHIO_WARNING_HPP
